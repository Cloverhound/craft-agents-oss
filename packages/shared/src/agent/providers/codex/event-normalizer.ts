/**
 * Event Normalizer — Codex SDK ThreadEvent/ThreadItem to AgentEvent Conversion
 *
 * Maps Codex SDK streaming events to the provider-agnostic AgentEvent union
 * used by CraftAgent and the rest of the application.
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

let itemCounter = 0;

function nextToolUseId(): string {
  return `codex-tool-${Date.now()}-${++itemCounter}`;
}

export function convertThreadStarted(event: ThreadStartedEvent): AgentEvent[] {
  return [{ type: "status", message: "Codex thread started" }];
}

export function convertTurnStarted(): AgentEvent[] {
  return [{ type: "status", message: "Processing..." }];
}

export function convertTurnCompleted(event: TurnCompletedEvent): AgentEvent[] {
  const usage: AgentEventUsage = {
    inputTokens: event.usage.input_tokens,
    outputTokens: event.usage.output_tokens,
    cacheReadTokens: event.usage.cached_input_tokens,
  };
  return [{ type: "complete", usage }];
}

export function convertTurnFailed(event: TurnFailedEvent): AgentEvent[] {
  return [{
    type: "typed_error",
    error: {
      code: "provider_error",
      title: "Codex Turn Failed",
      message: event.error.message,
      actions: [{ key: "r", label: "Retry", action: "retry" }],
      canRetry: true,
    },
  }];
}

export function convertThreadError(event: ThreadErrorEvent): AgentEvent[] {
  return [{ type: "error", message: event.message }];
}

export function convertItemStarted(event: ItemStartedEvent): AgentEvent[] {
  return convertItemToEvents(event.item, "started");
}

export function convertItemUpdated(event: ItemUpdatedEvent): AgentEvent[] {
  return convertItemToEvents(event.item, "updated");
}

export function convertItemCompleted(event: ItemCompletedEvent): AgentEvent[] {
  return convertItemToEvents(event.item, "completed");
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
    case "web_search":
      if (phase === "started") {
        return [{
          type: "tool_start",
          toolName: "WebSearch",
          toolUseId: item.id,
          input: { query: item.query },
        }];
      }
      if (phase === "completed") {
        return [{
          type: "tool_result",
          toolUseId: item.id,
          toolName: "WebSearch",
          result: `Web search completed: ${item.query}`,
          isError: false,
        }];
      }
      return [];
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
    if (item.text) {
      return [{ type: "text_delta", text: item.text }];
    }
    return [];
  }
  if (phase === "completed") {
    return [{ type: "text_complete", text: item.text, isIntermediate: false }];
  }
  return [];
}

function convertReasoning(
  item: ReasoningItem,
  phase: "started" | "updated" | "completed"
): AgentEvent[] {
  if (phase === "completed" && item.text) {
    return [{ type: "info", message: item.text }];
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

export function convertThreadEvent(event: ThreadEvent): AgentEvent[] {
  switch (event.type) {
    case "thread.started":
      return convertThreadStarted(event);
    case "turn.started":
      return convertTurnStarted();
    case "turn.completed":
      return convertTurnCompleted(event);
    case "turn.failed":
      return convertTurnFailed(event);
    case "item.started":
      return convertItemStarted(event);
    case "item.updated":
      return convertItemUpdated(event);
    case "item.completed":
      return convertItemCompleted(event);
    case "error":
      return convertThreadError(event);
    default:
      return [];
  }
}
