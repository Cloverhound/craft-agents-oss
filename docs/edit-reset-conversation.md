# Edit & Reset Conversation — Architecture & Design

> Internal design doc for the "Edit & Reset Conversation to a Previous Message" feature.

## Overview

This feature allows users to click on any previously sent user message, edit its content, and re-send it. The conversation is truncated to just before that message and the edited version is sent, producing a new response branch. This is the standard "edit and branch" pattern used by ChatGPT, Claude.ai, and similar chat interfaces.

The key design constraint is **preserving the full SDK transcript** — including compacted history, system prompts, and tool results that the LLM has already seen. Rather than destroying the SDK session and replaying messages, we use the SDK's `resumeSessionAt` + `forkSession` primitives to create a new branch from a specific point in the transcript.

## Architecture

The feature spans the full stack:

```
User clicks Edit                IPC Command                    SDK Reset
┌──────────────┐    ┌───────────────────────┐    ┌─────────────────────────┐
│ UserMessage   │    │ SessionManager        │    │ CraftAgent              │
│ Bubble (UI)   │───►│ .resetToMessage()     │───►│ .prepareResetToMessage()│
│               │    │                       │    │                         │
│ onEdit(text)  │    │ 1. Find sdkUuid       │    │ 1. Stop runner          │
│               │    │ 2. prepareResetToMessage│   │ 2. Set pendingResumeAt  │
│               │    │ 3. Truncate messages   │    │                         │
│               │    │ 4. Persist             │    │ On next chat():         │
│               │    │ 5. Emit reset event    │    │ - resumeSessionAt: uuid │
│               │    │ 6. sendMessage(edited) │    │ - forkSession: true     │
└──────────────┘    └───────────────────────┘    └─────────────────────────┘
        ▲                     │
        │                     ▼
┌──────────────┐    ┌───────────────────────┐
│ ChatDisplay   │    │ Event Processor       │
│ (renderer)    │◄───│ handleSessionReset    │
│               │    │ ToMessage()           │
│ Replaces msg  │    │                       │
│ array, sets   │    │ - Replace messages    │
│ isProcessing  │    │ - Clear streaming     │
└──────────────┘    │ - Set isProcessing    │
                    └───────────────────────┘
```

## Dual Storage Architecture

The application maintains two separate message stores:

| Store | Purpose | Location |
|-------|---------|----------|
| **Application JSONL** | UI display, persistence, sidebar previews | `session.jsonl` on disk, `managed.messages` in memory |
| **SDK Transcript** | LLM context, compacted history, tool results | Managed by Claude SDK internally |

On reset, **both stores must be addressed**:

- **Application store**: Truncated in-memory and re-persisted to JSONL
- **SDK transcript**: Not mutated — instead, `resumeSessionAt` tells the SDK to "fork" from a specific point, ignoring everything after it

This is why we track `sdkUuid` — it's the bridge between the two stores.

## Data Flow

### 1. sdkUuid Propagation

SDK assistant messages carry a `uuid` field that uniquely identifies them in the transcript. This UUID must flow through the entire pipeline:

```
SDK AssistantMessage.uuid
  → CraftAgent.convertSDKMessage() captures it as pendingUuid
  → AgentEvent { type: 'text_complete', sdkUuid: '...' }
  → SessionManager creates Message with sdkUuid
  → messageToStored() persists sdkUuid to JSONL
  → storedToMessage() restores sdkUuid on load
```

### 2. Reset Flow (Step by Step)

1. **User clicks Edit** (pencil icon) on a user message in `UserMessageBubble`
2. **`onEdit()`** fires → `ChatDisplay.handleStartEdit(messageId, content)` → sets edit state
3. **`MessageBubble` conditionally renders `FreeFormInput`** with full messaging controls (attach files, @mentions, model selector, working directory)
4. **User modifies text** and clicks submit/Enter in `FreeFormInput`
5. **`handleSubmitEdit(message, attachments, skillSlugs)`** fires → calls `onResetToMessage`
6. **`ChatPage.handleResetToMessage`** calls `window.electronAPI.sessionCommand(sessionId, { type: 'resetToMessage', messageId, editedContent })`
7. **IPC routing** in `ipc.ts` calls `sessionManager.resetToMessage(sessionId, messageId, editedContent)`
8. **`SessionManager.resetToMessage()`**:
   - Finds the target user message by ID
   - Scans backwards to find the nearest preceding assistant message with `sdkUuid`
   - If no `sdkUuid` found → returns `false` (can't reset)
   - **Initializes agent if needed** via `getOrCreateAgent(managed)` (lazy loading for inactive sessions)
   - Calls `agent.prepareResetToMessage(sdkUuid)` — stops the runner, stores the resume point
   - Truncates `managed.messages` to everything before the target message
   - Zeros `tokenUsage` (SDK will report fresh usage)
   - Persists truncated state to JSONL
   - Emits `session_reset_to_message` event to renderer with truncated messages
   - Calls `this.sendMessage(sessionId, editedContent)` — sends the edited message as a new turn
9. **Renderer receives event** → `processEvent` → `handleSessionResetToMessage`:
   - Replaces message array wholesale
   - Sets `isProcessing: true`
   - Clears any streaming state
10. **Agent.chat()** is invoked with the edited message:
   - `buildSessionOptions()` sees `pendingResumeAt` and sets `resumeSessionAt` + `forkSession`
   - SDK forks the transcript from the specified UUID
   - Agent processes the new message with full prior context preserved
   - `pendingResumeAt` is cleared after first SDK message received

## Key Design Decisions

### Why `resumeSessionAt` + `forkSession` instead of replaying messages?

Replaying messages would:
- Lose compacted context (the SDK compresses old turns into summaries)
- Re-execute tools unnecessarily
- Cost additional tokens for re-processing
- Risk different behavior due to non-determinism

Using `resumeSessionAt` preserves the exact SDK state up to the fork point, including all compacted history. The `forkSession` flag tells the SDK to create a new branch rather than mutating the original transcript.

### Why scan backwards for `sdkUuid` from the preceding assistant message?

The `sdkUuid` marks the last assistant message the SDK "remembers" before the user message being edited. By resuming from that point, the SDK sees everything up to and including that assistant response, then receives the new (edited) user message as a fresh input.

### Why is the edit button hidden during processing?

Editing while the agent is processing would create a race condition — the agent might be mid-response when the reset fires. The `onEditMessage` callback is only passed when `!session?.isProcessing`, so the edit pencil icon never appears during active processing.

### Why not use a confirmation dialog?

The feature is designed to feel lightweight and responsive. Since the original messages are preserved in the SDK transcript (via forking), the operation is not truly destructive — the LLM retains all context. The UI truncation is the only visible change, and it's immediately followed by the new response.

### Why use `FreeFormInput` instead of a simple textarea?

For consistency and feature parity with the main chat input. Users expect the same capabilities when editing:
- **File attachments**: Add images/documents when editing
- **@mentions**: Include sources, skills, or working directory references
- **Model selection**: Change the model for the re-submission
- **Rich text input**: Markdown preview, syntax highlighting

Reusing `FreeFormInput` provides all these features automatically and maintains a consistent UX.

## Files Modified

| File | Layer | Changes |
|------|-------|---------|
| `packages/core/src/types/message.ts` | Types | Added `sdkUuid?: string` to `AgentEvent`, `Message`, `StoredMessage` |
| `packages/shared/src/agent/craft-agent.ts` | Agent | UUID capture in `convertSDKMessage`, `prepareResetToMessage()`, `buildSessionOptions()` integration |
| `apps/electron/src/main/sessions.ts` | Main Process | `resetToMessage()` method, `sdkUuid` in `messageToStored`/`storedToMessage` |
| `apps/electron/src/main/ipc.ts` | IPC | `resetToMessage` command routing |
| `apps/electron/src/shared/types.ts` | Shared Types | `resetToMessage` command, `session_reset_to_message` event |
| `apps/electron/src/renderer/event-processor/types.ts` | Renderer Types | `SessionResetToMessageEvent` interface |
| `apps/electron/src/renderer/event-processor/handlers/session.ts` | Renderer Handler | `handleSessionResetToMessage` pure function |
| `apps/electron/src/renderer/event-processor/processor.ts` | Renderer Processor | `session_reset_to_message` case routing |
| `packages/ui/src/components/chat/UserMessageBubble.tsx` | UI Component | `onEdit?: () => void` prop (trigger only), pencil icon on hover, no internal edit state |
| `apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx` | Renderer UI | Edit state management (`editingMessageId`, `editContent`, `editAttachments`), conditionally renders `FreeFormInput` for editing, `onResetToMessage` prop threading, `onEditMessage` in `MessageBubbleProps` |
| `apps/electron/src/renderer/pages/ChatPage.tsx` | Renderer Page | `handleResetToMessage` IPC callback |

## Backward Compatibility

- Messages created before this feature have no `sdkUuid` field
- The edit pencil icon only appears when `onEdit` is provided by the parent
- The parent only provides `onEdit` when the session is not processing
- If `resetToMessage()` can't find a preceding assistant message with `sdkUuid`, it returns `false` and logs the failure reason
- **Agent lazy loading**: Inactive/old sessions don't have agents initialized in memory. `resetToMessage` calls `getOrCreateAgent()` to initialize on-demand
- No migration needed — old sessions simply don't show the edit button on messages that predate the feature

## Testing

Tests are in `apps/electron/src/renderer/event-processor/__tests__/session-reset.test.ts`:

- **Handler tests**: Message replacement, processing state, streaming state clearing, session field preservation, immutability, side effect verification
- **Processor routing tests**: `processEvent` correctly routes `session_reset_to_message` events
- **Scenario tests**: Realistic multi-message conversation edit, first-message edge case, reset during active streaming

Run tests:
```bash
bun test apps/electron/src/renderer/event-processor/__tests__/session-reset.test.ts
```
