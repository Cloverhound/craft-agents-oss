# Work Queues — Architecture & Design

> Internal design doc for the Work Queue system.
> For the user-facing reference, see [`packages/shared/assets/docs/queue.md`](../packages/shared/assets/docs/queue.md).

## Overview

Work Queues let agents programmatically create, manage, and surface actionable tasks derived from external integrations (Xero invoices, Znuny tickets, GitHub issues) or agent-generated logic. Tasks flow through configurable lifecycle states and are displayed in the Electron app's sidebar, navigator panel, and detail views.

The system is split into two phases:

- **Phase 1** — Core data layer: types, storage, CRUD, validation, MCP tools (`packages/shared/src/queue/`)
- **Phase 2** — Electron UI integration: IPC channels, preload bridge, Jotai atoms, React hooks, routing, UI components (`apps/electron/`)

## Data Model

```
TaskTypeConfig (per type)          QueueTask (per task)
┌─────────────────────────┐        ┌─────────────────────────┐
│ id/slug                 │        │ id: tsk-YYMMDD-hex8     │
│ name, description, icon │        │ typeSlug ──────────────►│
│ source?                 │        │ dedupId?                │
│ dedupTemplate?          │        │ title                   │
│ fields: { schema }      │        │ state                   │
│ states: [ lifecycle ]   │        │ priority?               │
│ displayTemplate?        │        │ data: { ... }           │
│ createdAt, updatedAt    │        │ labels: []              │
└─────────────────────────┘        │ sourceSessionId?        │
                                   │ linkedSessionIds: []    │
                                   │ createdAt, updatedAt    │
                                   │ completedAt?            │
                                   │ createdBy               │
                                   └─────────────────────────┘
```

### State Categories

Every lifecycle state belongs to either `open` (active/actionable) or `closed` (completed/dismissed). This mirrors the session status pattern used elsewhere in the app and enables category-level filtering in the UI.

### Task IDs

Format: `tsk-{YYMMDD}-{random8hex}` (e.g., `tsk-260206-a1b2c3d4`)

- Date prefix enables chronological sorting
- 8 random hex bytes ensure uniqueness
- Globally unique within a workspace

## Deduplication

### Problem

When syncing from external sources (e.g., fetching all overdue Xero invoices), the same sync operation may run multiple times. Without dedup, each run creates duplicate tasks.

### Solution: `dedupTemplate` + `dedupId`

**On the type** — a `dedupTemplate` string with `{field}` placeholders:

```json
{
  "dedupTemplate": "xero:{invoice_number}"
}
```

**On the task** — a resolved `dedupId` computed at creation time:

```json
{
  "dedupId": "xero:INV-2828"
}
```

### Resolution Flow

1. When `createTask` is called, resolve the `dedupId`:
   - If the caller passes an explicit `dedupId` → use it (override)
   - Else if the type has a `dedupTemplate` → substitute `{field}` placeholders from task data
   - Else → no dedup, normal create
2. If a `dedupId` resolves, search for an existing task with the same `typeSlug` + `dedupId`
3. **If found** → upsert: update `data`, `title`, `priority`, `labels`, `updatedAt`. Preserve `state`, `completedAt`, `linkedSessionIds`, `createdAt`, `createdBy`, `sourceSessionId`
4. **If not found** → create a new task with the `dedupId` set

### Template Examples

```
// External system ID
"xero:{invoice_number}"         → "xero:INV-2828"

// Agent-generated compound key
"{customer}:{month}"            → "Acme Corp:2026-02"

// Simple single-field key
"{ticket_id}"                   → "TKT-4821"
```

The template is intentionally freeform — the source of the key doesn't matter. It could reference an external system ID, or fields the agent itself populates.

### Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `resolveDedupId(template, data)` | `crud.ts` | Substitutes `{field}` placeholders, returns null if any field missing |
| `findTaskByDedupId(workspace, typeSlug, dedupId)` | `storage.ts` | Scans tasks for a match (linear scan, sufficient at filesystem scale) |
| `createTask` (modified) | `crud.ts` | Resolves dedupId, checks for existing, upserts or creates |

## Storage Layout

```
~/.craft-agent/workspaces/{ws}/
  queue/
    config.json                    # Queue-level settings (version, enabled, autoArchiveDays)
    types/
      {type-slug}/
        config.json                # TaskTypeConfig
        icon.svg|png|jpg           # Type icon (optional)
        display.md                 # Handlebars-style detail view template
    tasks/
      {task-id}.json               # QueueTask
```

All data is flat JSON files — one per task, one per type config. This keeps reads/writes atomic and avoids the overhead of a database or JSONL for small object counts.

## Package Structure

### Phase 1: `packages/shared/src/queue/`

| File | Purpose |
|------|---------|
| `types.ts` | TypeScript interfaces: `TaskTypeConfig`, `QueueTask`, `CreateTaskInput`, etc. |
| `storage.ts` | Filesystem I/O: load, save, list, delete tasks and types. `findTaskByDedupId`. |
| `crud.ts` | Business logic: `createTask` (with dedup/upsert), `updateTask`, `bulkCreateTasks`, `resolveDedupId` |
| `validation.ts` | Config validation: type schemas, task integrity, orphan detection, dedup checks |
| `queue-tools.ts` | MCP tool factories: `queue_push`, `queue_bulk_push`, `queue_update`, `queue_get`, `queue_list`, `queue_stats`, `queue_delete`, `queue_type_create`, `queue_type_list`, `queue_type_get` |
| `index.ts` | Barrel exports |

These tools are registered in `packages/shared/src/agent/session-scoped-tools.ts` alongside credential, source, and LLM tools.

### Phase 2: Electron Integration (`apps/electron/`)

#### IPC Channels (`src/shared/types.ts`)

Queue operations use Electron IPC to bridge main ↔ renderer:

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `QUEUE_LIST_TYPES` | renderer → main | List all task types |
| `QUEUE_LIST_TASKS` | renderer → main | List tasks with optional filters |
| `QUEUE_GET_TASK` | renderer → main | Get a single task by ID |
| `QUEUE_GET_STATS` | renderer → main | Get summary statistics |
| `QUEUE_UPDATE_TASK` | renderer → main | Update task state/data |
| `QUEUE_DELETE_TASK` | renderer → main | Delete a task |
| `QUEUE_CHANGED` | main → renderer | Broadcast: queue data changed |

#### Preload Bridge (`src/preload/index.ts`)

Exposes queue IPC to the renderer via `contextBridge.exposeInMainWorld`:

```typescript
window.api.queue.listTypes(workspaceId)
window.api.queue.listTasks(workspaceId, filter?)
window.api.queue.getTask(workspaceId, taskId)
window.api.queue.getStats(workspaceId)
window.api.queue.updateTask(workspaceId, taskId, updates)
window.api.queue.deleteTask(workspaceId, taskId)
window.api.queue.onChanged(callback)
```

#### ConfigWatcher (`src/main/watcher.ts`)

Watches the `queue/` directory for filesystem changes (task files created/modified/deleted by agents). Fires debounced `QUEUE_CHANGED` events via `SessionManager.broadcastToAll`.

#### State Management

| Layer | File | Purpose |
|-------|------|---------|
| Atoms | `src/renderer/atoms/queue.ts` | Jotai atoms: `queueTasksAtom`, `queueTypesAtom`, `queueStatsAtom` |
| Hook | `src/renderer/hooks/useQueue.ts` | `useQueue(workspaceId, filter?)` — CRUD + live IPC subscription |

The hook returns `{ tasks, types, stats, updateTask, deleteTask, isLoading }` and auto-refreshes when `QUEUE_CHANGED` fires.

#### Navigation & Routing

**Route format** (compound routes in `src/shared/route-parser.ts`):

| Route | View |
|-------|------|
| `queue` | Queue list (all types) |
| `queue/type/{slug}` | Queue list filtered by type |
| `queue/task/{id}` | Task detail page |
| `queue/type-info/{slug}` | Type detail page |

**NavigationState**: `QueueNavigationState` with `navigator: 'queue'`, optional `typeFilter`, and `details` object.

#### UI Components

| Component | File | Purpose |
|-----------|------|---------|
| `QueueListPanel` | `app-shell/QueueListPanel.tsx` | Navigator panel: task cards with state icon, title, badges, age |
| `QueueTaskMenu` | `app-shell/QueueTaskMenu.tsx` | Context/dropdown menu: copy ID, delete |
| `QueueTaskDetailPage` | `pages/QueueTaskDetailPage.tsx` | Detail view: state transitions, metadata table, data fields |
| `QueueTypeDetailPage` | `pages/QueueTypeDetailPage.tsx` | Type detail: metadata, lifecycle states, field schema |

**Sidebar entry** in `AppShell.tsx`: Expandable queue section with type sub-items showing open task counts. Conditionally shown when `queueTypes.length > 0`.

#### Mention System

Tasks can be referenced in chat messages using bracket syntax:

```
[task:{type-slug}:{task-id}]
```

Parsed by `src/renderer/lib/mentions.ts`, rendered as inline badges by `mention-badge.tsx`.

## MCP Tools

All queue tools are defined in `queue-tools.ts` as factory functions that close over `sessionId` and `workspaceRootPath`. They are registered once per session in `session-scoped-tools.ts`.

### Push Tools (with dedup)

`queue_push` and `queue_bulk_push` accept an optional `dedupId` parameter. If not provided, the dedupId is resolved from the type's `dedupTemplate`. Both tools call `createTask` which handles the upsert logic.

`queue_type_create` accepts an optional `dedupTemplate` parameter.

### Read Tools

`queue_list`, `queue_get`, `queue_stats`, `queue_type_list`, `queue_type_get` — straightforward reads, no dedup logic.

## Validation

Run `config_validate({ target: "queue" })` to check the full queue system:

1. Queue config.json structure
2. All task type configs (fields, states, slug format, dedupTemplate field references)
3. All tasks (valid type references, valid states, required fields)
4. Orphaned tasks (referencing deleted types)
5. Duplicate dedupIds within the same type

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Flat JSON files per task | Atomic reads/writes, no DB overhead, easy debugging via filesystem |
| Per-type lifecycle states | Type-specific workflows (invoice followup vs. ticket triage have different states) |
| `open`/`closed` categories | Matches session status pattern, enables cross-type filtering |
| Agent as primary creator | Agents create types and push tasks; users manage workflow state via UI |
| Dedup via template, not caller | Type author defines the dedup strategy once; all pushers inherit it automatically |
| Linear scan for dedup lookup | Sufficient at filesystem scale (~100s of tasks); index can be added later if needed |
| Labels reuse workspace system | `id::value` format, no separate label management for tasks |
| Date-prefixed task IDs | Chronological sorting and easy cleanup/archival |
| ConfigWatcher for live updates | Agent writes task files → watcher fires → renderer refreshes via IPC |
