# Work Queue

The Work Queue system lets agents programmatically create, manage, and surface actionable tasks derived from external integrations (Xero invoices, Znuny tickets, GitHub issues, etc.).

## Core Concepts

- **Task Types** — define the field schema, lifecycle states, and display template for a category of tasks
- **Tasks** — individual items with typed data payloads, state, priority, and labels
- **Agent-Managed** — agents create types, push tasks, and manage lifecycle via tools

## Storage Layout

```
~/.craft-agent/workspaces/{ws}/
  queue/
    config.json                    # Queue-level settings
    types/
      {type-slug}/
        config.json                # Task type definition
        icon.svg|png|jpg           # Type icon
        display.md                 # Markdown template for task detail view
    tasks/
      {task-id}.json               # Individual task file
```

## Queue Config

Stored at `queue/config.json`:

```json
{
  "version": 1,
  "enabled": true,
  "defaultFilter": "open",
  "autoArchiveDays": 30
}
```

| Field | Type | Description |
|-------|------|-------------|
| `version` | number | Schema version (start at 1) |
| `enabled` | boolean | Whether the queue is active |
| `defaultFilter` | string | Default state filter when viewing (`"open"` or `"closed"`) |
| `autoArchiveDays` | number | Auto-archive completed tasks after N days (0 = never) |

## Task Types

Each type is a folder at `queue/types/{slug}/` containing a `config.json`:

```json
{
  "id": "xero-overdue-invoice",
  "name": "Xero Overdue Invoice",
  "slug": "xero-overdue-invoice",
  "description": "Follow-up on overdue Xero invoices",
  "icon": "https://www.xero.com/favicon-32x32.png",
  "tagline": "Overdue invoice requiring follow-up",
  "source": "xero",
  "fields": {
    "invoiceId": { "type": "string", "required": true, "label": "Invoice ID" },
    "contactName": { "type": "string", "required": true, "label": "Contact" },
    "amountDue": { "type": "number", "label": "Amount Due" },
    "dueDate": { "type": "date", "label": "Due Date" },
    "daysOverdue": { "type": "number", "label": "Days Overdue" },
    "url": { "type": "url", "label": "Xero Link" },
    "notes": { "type": "string", "label": "Notes" }
  },
  "states": [
    { "id": "pending", "label": "Pending", "category": "open", "color": "foreground/50", "isDefault": true },
    { "id": "in-progress", "label": "In Progress", "category": "open", "color": "info" },
    { "id": "done", "label": "Done", "category": "closed", "color": "success" },
    { "id": "skipped", "label": "Skipped", "category": "closed", "color": "foreground/30" }
  ],
  "displayTemplate": "display.md",
  "createdAt": 1738886400000,
  "updatedAt": 1738886400000
}
```

### Task Type Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | Unique ID (matches folder slug) |
| `name` | string | Display name |
| `slug` | string | URL-safe slug (lowercase, hyphens) |
| `description` | string | Brief description |
| `icon` | string? | Emoji or URL (auto-downloaded) |
| `tagline` | string? | Short tagline for list display |
| `source` | string? | Originating source integration slug |
| `dedupTemplate` | string? | Dedup template with `{field}` placeholders (see Deduplication) |
| `fields` | Record | Field schema (see below) |
| `states` | array | Lifecycle states (see below) |
| `displayTemplate` | string? | Reference to display.md template |
| `createdAt` | number | Creation timestamp (ms) |
| `updatedAt` | number | Last update timestamp (ms) |

### Field Types

| Type | Description | Example Value |
|------|-------------|---------------|
| `string` | Text value | `"Acme Corp"` |
| `number` | Numeric value | `12500.00` |
| `date` | ISO date (YYYY-MM-DD) | `"2026-01-22"` |
| `url` | URL string | `"https://example.com"` |
| `boolean` | True/false | `true` |
| `json` | Arbitrary JSON | `{"nested": "data"}` |

### Field Definition

```json
{
  "type": "string",
  "label": "Contact Name",
  "required": true
}
```

### Lifecycle States

Each state has a category (`open` or `closed`) matching the session status pattern:

- **open** — task is active/actionable
- **closed** — task is completed/dismissed

At least one state should be marked `isDefault: true` for new tasks.

### Color Format

Same as statuses and labels — see statuses documentation for full details.

**System colors:** `"accent"`, `"info"`, `"success"`, `"destructive"`, `"foreground"` (with optional `/opacity` 0–100)

**Custom colors:** `{ "light": "#EF4444", "dark": "#F87171" }`

## Tasks

Individual tasks are stored at `queue/tasks/{task-id}.json`:

```json
{
  "id": "tsk-260206-a1b2c3d4",
  "typeSlug": "xero-overdue-invoice",
  "title": "Follow up: Acme Corp - INV-0042 ($12,500 overdue 15 days)",
  "state": "pending",
  "priority": 1,
  "data": {
    "invoiceId": "INV-0042",
    "contactName": "Acme Corp",
    "amountDue": 12500.00,
    "dueDate": "2026-01-22",
    "daysOverdue": 15,
    "url": "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=abc-123",
    "notes": "Large client — escalate to Ed if no response by Feb 10"
  },
  "labels": ["urgent", "client::acme-corp"],
  "sourceSessionId": "260206-silver-glen",
  "linkedSessionIds": [],
  "createdAt": 1738886400000,
  "updatedAt": 1738886400000,
  "completedAt": null,
  "createdBy": "agent"
}
```

### Task Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | Unique ID: `tsk-{YYMMDD}-{random8hex}` |
| `typeSlug` | string | Task type slug |
| `dedupId` | string? | Resolved dedup key (see Deduplication) |
| `title` | string | Human-readable title |
| `state` | string | Current lifecycle state ID |
| `priority` | number? | Numeric priority (lower = higher) |
| `data` | Record | Typed data payload matching type schema |
| `labels` | string[] | Labels (bare IDs or `"id::value"`) |
| `sourceSessionId` | string? | Session that created this task |
| `linkedSessionIds` | string[] | Sessions referencing this task |
| `createdAt` | number | Creation timestamp (ms) |
| `updatedAt` | number | Last update timestamp (ms) |
| `completedAt` | number? | Completion timestamp (auto-set on close) |
| `createdBy` | string | `"agent"` or `"user"` |

### Task ID Format

`tsk-{YYMMDD}-{random8hex}` — e.g., `tsk-260206-a1b2c3d4`

- Date prefix enables chronological sorting
- 8 random hex characters ensure uniqueness
- Globally unique within a workspace

## Available Tools

### Write Operations (blocked in Explore mode)

| Tool | Description |
|------|-------------|
| `queue_push` | Create a new task (with dedup upsert if dedupTemplate/dedupId set) |
| `queue_bulk_push` | Create multiple tasks in one batch call (with dedup upsert) |
| `queue_update` | Update task state, data fields, priority, or labels |
| `queue_delete` | Delete a task |
| `queue_type_create` | Create a new task type definition |

### Read Operations (allowed in Explore mode)

| Tool | Description |
|------|-------------|
| `queue_get` | Get a specific task by ID |
| `queue_list` | List/query tasks with filters (type, state, labels, date range) |
| `queue_stats` | Get summary counts by type and state |
| `queue_type_list` | List available task types |
| `queue_type_get` | Get task type definition |

## Display Templates

Each task type can have a `display.md` markdown template that defines how the task detail view renders. Templates use `{{field}}` interpolation:

```markdown
# {{title}}

**Invoice:** {{data.invoiceId}} | **Contact:** {{data.contactName}}
**Amount Due:** ${{data.amountDue}} | **Days Overdue:** {{data.daysOverdue}}

{{#if data.url}}
[Open in Xero]({{data.url}})
{{/if}}

---

{{#if data.notes}}
## Notes
{{data.notes}}
{{/if}}
```

A skeleton template is auto-generated when creating a type via `queue_type_create`.

## Task Reference Syntax

Tasks can be referenced in chat using bracket mention syntax:

```
[task:{type-slug}:{task-id}]
```

Example: `[task:xero-overdue-invoice:tsk-260206-a1b2c3d4]`

## Example Workflows

### Create a Type and Queue Tasks

```
User: "Queue up follow-up tasks for all Xero invoices overdue by more than 7 days"

Agent:
1. queue_type_list → check if type exists
2. queue_type_create → define "xero-overdue-invoice" type (if needed)
3. Fetch overdue invoices via Xero API (using credential)
4. queue_bulk_push → create tasks for each invoice
5. Return summary: "Queued 8 tasks for overdue invoices"
```

### Process Queue Tasks

```
User: "Show me the pending tasks in the queue"

Agent:
1. queue_list with stateCategory: "open"
2. Present formatted list to user
```

### Update Task State

```
User: "Mark the Acme Corp invoice task as done"

Agent:
1. queue_list → find the task
2. queue_update → set state to "done"
3. Confirm completion
```

## Validation

Validate queue configuration with:

```
config_validate({ target: "queue" })
```

This checks:
- Queue config.json structure
- All task type configs (fields, states, slug format)
- All tasks (valid type references, valid states, required fields)
- Orphaned tasks (referencing deleted types)

## Deduplication

Task types can define a `dedupTemplate` — a pattern string with `{field}` placeholders that resolves to a deterministic dedup ID from task data. This makes push operations idempotent: re-syncing from an external source updates existing tasks instead of creating duplicates.

### Setup

Add `dedupTemplate` to the task type definition:

```json
{
  "name": "Overdue Invoice Followup",
  "source": "xero",
  "dedupTemplate": "xero:{invoice_number}",
  "fields": {
    "invoice_number": { "type": "string", "label": "Invoice #", "required": true }
  }
}
```

### How It Works

When a task is pushed (`queue_push` or `queue_bulk_push`):

1. The `dedupId` is resolved from the template: `"xero:{invoice_number}"` + `{ invoice_number: "INV-2828" }` = `"xero:INV-2828"`
2. If an existing task has the same `typeSlug` + `dedupId`, it's **upserted**: `data`, `title`, `priority`, and `labels` are updated, while `state`, `completedAt`, and other workflow fields are preserved
3. If no match, a new task is created with the `dedupId` set

### Template Examples

```
// External system ID
"xero:{invoice_number}"         → "xero:INV-2828"

// Agent-generated compound key
"{customer}:{month}"            → "Acme Corp:2026-02"

// Simple single-field key
"{ticket_id}"                   → "TKT-4821"
```

### Explicit Override

Callers can pass `dedupId` directly in the push input to override template resolution:

```
queue_push({ typeSlug: "...", title: "...", data: {...}, dedupId: "custom:my-key" })
```

This is useful when the key comes from runtime context not in the data fields, or the type doesn't define a template.

### Validation

`config_validate({ target: "queue" })` checks that:
- All `{field}` references in `dedupTemplate` exist in the type's field schema
- No duplicate `dedupId` values exist within the same type

## Design Decisions

- **Flat task files** — each task is a single JSON file for atomic reads/writes (no JSONL overhead for small objects)
- **Per-type lifecycle states** — same `open`/`closed` category pattern as session statuses, enables type-specific workflows
- **Field schema validation** — types define their schema, agents validate data when pushing tasks
- **Agent as primary creator** — agents create types and push tasks; users manage via UI
- **Labels reuse** — tasks use the workspace label system (`id::value` format)
- **Session linking** — bidirectional references between tasks and sessions
- **Date-prefixed IDs** — chronological sorting and easy cleanup
