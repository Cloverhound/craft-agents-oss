/**
 * Event Normalizer — Codex SDK ThreadEvent/ThreadItem to AgentEvent Conversion
 *
 * Maps Codex SDK streaming events to the provider-agnostic AgentEvent union
 * used by CraftAgent and the rest of the application.
 *
 * Key differences from the Claude normalizer:
 *   - Codex SDK reports cumulative input_tokens across all turns in a session.
 *     We pass the raw value through with inputTokensMode: "cumulative" so
 *     the session manager can store it directly without fragile delta math.
 *   - Codex emits multiple agent_message items per turn (interleaved with tool use).
 *     We buffer text_complete events and mark earlier ones as isIntermediate: true
 *     (only the last text before turn.completed gets isIntermediate: false).
 *   - For item.updated events on agent_message, item.text contains the full
 *     accumulated text (not a delta). We track per-item offsets to emit true deltas.
 */

import type {
  ThreadEvent,
  ThreadItem,
  ItemStartedEvent,
  ItemUpdatedEvent,
  ItemCompletedEvent,
  TurnCompletedEvent,
  TurnFailedEvent,
  ThreadStartedEvent,
  ThreadErrorEvent,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  AgentMessageItem,
  ReasoningItem,
  ErrorItem,
} from "@openai/codex-sdk";
import type { AgentEvent, AgentEventUsage } from "@craft-agent/core/types";
import { getModelContextWindow } from "../../../config/models.ts";

let itemCounter = 0;
let resolvedContextWindow: number | undefined;
let pendingText: { text: string; turnId?: string } | null = null;
const emittedTextLength = new Map<string, number>();

function nextToolUseId(): string {
  return `codex-tool-${Date.now()}-${++itemCounter}`;
}

export function setCodexModel(modelId: string): void {
  resolvedContextWindow = getModelContextWindow(modelId);
}

export function resetCodexNormalizerState(): void {
  itemCounter = 0;
  pendingText = null;
  emittedTextLength.clear();
}

function flushPendingText(isIntermediate: boolean): AgentEvent[] {
  if (!pendingText) return [];
  const event: AgentEvent = {
    type: "text_complete",
    text: pendingText.text,
    isIntermediate,
  };
  pendingText = null;
  return [event];
}

/**
 * Main entry point: converts a Codex ThreadEvent into AgentEvent(s).
 *
 * This function manages cross-event state (buffered text, cumulative tokens)
 * to produce correct isIntermediate flags and per-turn inputTokens.
 */
export function convertThreadEvent(event: ThreadEvent): AgentEvent[] {
  const results: AgentEvent[] = [];

  switch (event.type) {
    case "thread.started":
      results.push({ type: "status", message: "Codex thread started" });
      break;

    case "turn.started":
      results.push({ type: "status", message: "Processing..." });
      break;

    case "turn.completed": {
      results.push(...flushPendingText(false));
      emittedTextLength.clear();

      const usage: AgentEventUsage = {
        inputTokens: event.usage.input_tokens,
        outputTokens: event.usage.output_tokens,
        cacheReadTokens: event.usage.cached_input_tokens,
        contextWindow: resolvedContextWindow,
        inputTokensMode: "cumulative",
      };
      results.push({ type: "complete", usage });
      break;
    }

    case "turn.failed":
      results.push(...flushPendingText(false));
      results.push({
        type: "typed_error",
        error: {
          code: "provider_error",
          title: "Codex Turn Failed",
          message: event.error.message,
          actions: [{ key: "r", label: "Retry", action: "retry" }],
          canRetry: true,
        },
      });
      break;

    case "item.started":
      results.push(...flushPendingTextIfToolItem(event.item));
      results.push(...convertItemToEvents(event.item, "started"));
      break;

    case "item.updated":
      results.push(...convertItemToEvents(event.item, "updated"));
      break;

    case "item.completed":
      results.push(...flushPendingTextIfToolItem(event.item));
      results.push(...convertItemToEvents(event.item, "completed"));
      break;

    case "error":
      results.push(...flushPendingText(false));
      results.push({ type: "error", message: event.message });
      break;
  }

  return results;
}

function flushPendingTextIfToolItem(item: ThreadItem): AgentEvent[] {
  if (!pendingText) return [];
  if (item.type === "command_execution" || item.type === "file_change" ||
      item.type === "mcp_tool_call" || item.type === "web_search") {
    return flushPendingText(true);
  }
  if (item.type === "agent_message") {
    return flushPendingText(true);
  }
  return [];
}

function convertItemToEvents(
  item: ThreadItem,
  phase: "started" | "updated" | "completed"
): AgentEvent[] {
  switch (item.type) {
    case "agent_message":
      return convertAgentMessage(item, phase);
    case "reasoning":
      return convertReasoning(item, phase);
    case "command_execution":
      return convertCommandExecution(item, phase);
    case "file_change":
      return convertFileChange(item, phase);
    case "mcp_tool_call":
      return convertMcpToolCall(item, phase);
    case "web_search": {
      const query = item.query || (item as any).action?.query || "";
      if (phase === "started") {
        return [{
          type: "tool_start",
          toolName: "WebSearch",
          toolUseId: item.id,
          input: { query },
          intent: query || undefined,
        }];
      }
      if (phase === "completed") {
        const events: AgentEvent[] = [];
        if (query) {
          events.push({
            type: "tool_start",
            toolName: "WebSearch",
            toolUseId: item.id,
            input: {},
            intent: query,
          });
        }
        events.push({
          type: "tool_result",
          toolUseId: item.id,
          toolName: "WebSearch",
          result: `Web search completed: ${query}`,
          isError: false,
        });
        return events;
      }
      return [];
    }
    case "todo_list":
      return [];
    case "error":
      return convertErrorItem(item);
    default:
      return [];
  }
}

function convertAgentMessage(
  item: AgentMessageItem,
  phase: "started" | "updated" | "completed"
): AgentEvent[] {
  if (phase === "started" || phase === "updated") {
    if (!item.text) return [];
    const prev = emittedTextLength.get(item.id) ?? 0;
    if (item.text.length > prev) {
      const delta = item.text.slice(prev);
      emittedTextLength.set(item.id, item.text.length);
      return [{ type: "text_delta", text: delta }];
    }
    return [];
  }
  if (phase === "completed") {
    const events: AgentEvent[] = [];
    const prev = emittedTextLength.get(item.id) ?? 0;
    if (item.text.length > prev) {
      const delta = item.text.slice(prev);
      emittedTextLength.set(item.id, item.text.length);
      events.push({ type: "text_delta", text: delta });
    }
    pendingText = { text: item.text };
    return events;
  }
  return [];
}

function convertReasoning(
  item: ReasoningItem,
  phase: "started" | "updated" | "completed"
): AgentEvent[] {
  if (phase === "completed" && item.text) {
    const cleaned = item.text.replace(/\*\*/g, "");
    return [{ type: "status", message: cleaned }];
  }
  return [];
}

function convertCommandExecution(
  item: CommandExecutionItem,
  phase: "started" | "updated" | "completed"
): AgentEvent[] {
  if (phase === "started") {
    return [{
      type: "tool_start",
      toolName: "Bash",
      toolUseId: item.id,
      input: { command: item.command },
    }];
  }
  if (phase === "completed") {
    const isError = item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0);
    return [{
      type: "tool_result",
      toolUseId: item.id,
      toolName: "Bash",
      result: item.aggregated_output || (isError ? `Command failed with exit code ${item.exit_code}` : "Command completed"),
      isError,
      input: { command: item.command },
    }];
  }
  return [];
}

function convertFileChange(
  item: FileChangeItem,
  phase: "started" | "updated" | "completed"
): AgentEvent[] {
  if (phase !== "completed") return [];

  const events: AgentEvent[] = [];
  const isError = item.status === "failed";

  for (const change of item.changes) {
    const toolUseId = `${item.id}-${change.path}`;
    const toolName = change.kind === "add" ? "Write" : change.kind === "delete" ? "Delete" : "Edit";

    events.push({
      type: "tool_start",
      toolName,
      toolUseId,
      input: { path: change.path },
    });
    events.push({
      type: "tool_result",
      toolUseId,
      toolName,
      result: `${change.kind}: ${change.path}`,
      isError,
      input: { path: change.path },
    });
  }

  return events;
}

function convertMcpToolCall(
  item: McpToolCallItem,
  phase: "started" | "updated" | "completed"
): AgentEvent[] {
  const toolName = `${item.server}__${item.tool}`;

  if (phase === "started") {
    return [{
      type: "tool_start",
      toolName,
      toolUseId: item.id,
      input: (item.arguments ?? {}) as Record<string, unknown>,
    }];
  }
  if (phase === "completed") {
    const isError = item.status === "failed";
    let result = "";
    if (item.error) {
      result = item.error.message;
    } else if (item.result) {
      result = JSON.stringify(item.result.content);
    } else {
      result = "MCP tool call completed";
    }
    return [{
      type: "tool_result",
      toolUseId: item.id,
      toolName,
      result,
      isError,
      input: (item.arguments ?? {}) as Record<string, unknown>,
    }];
  }
  return [];
}

function convertErrorItem(item: ErrorItem): AgentEvent[] {
  return [{ type: "error", message: item.message }];
}
