/**
 * Codex Provider Tests
 *
 * Validates the CodexAgent implementation, Codex event normalization,
 * model detection, and authentication verification.
 */

import { describe, it, expect } from "bun:test";
import { CodexAgent } from "../providers/codex/codex-agent.ts";
import {
  convertThreadEvent,
  convertThreadStarted,
  convertTurnStarted,
  convertTurnCompleted,
  convertTurnFailed,
  convertThreadError,
  convertItemStarted,
  convertItemCompleted,
} from "../providers/codex/event-normalizer.ts";
import {
  isCodexModel,
  isClaudeModel,
  getModelsForProvider,
  detectProviderFromModel,
  CODEX_MODELS,
  CLAUDE_MODELS,
} from "../../config/models.ts";
import type { ProviderFeature } from "../providers/types.ts";

// ============================================================================
// Test Helpers
// ============================================================================

function createThreadStartedEvent() {
  return { type: "thread.started" as const, thread_id: "thread-123" };
}

function createTurnCompletedEvent(usage = { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10 }) {
  return { type: "turn.completed" as const, usage };
}

function createTurnFailedEvent(message = "Something went wrong") {
  return { type: "turn.failed" as const, error: { message } };
}

function createAgentMessageItem(text: string, phase: "started" | "completed" = "completed") {
  return {
    type: `item.${phase}` as "item.started" | "item.completed",
    item: { id: "msg-1", type: "agent_message" as const, text },
  };
}

function createCommandExecutionItem(
  command: string,
  phase: "started" | "completed" = "completed",
  exitCode = 0,
  output = "command output"
) {
  return {
    type: `item.${phase}` as "item.started" | "item.completed",
    item: {
      id: "cmd-1",
      type: "command_execution" as const,
      command,
      aggregated_output: output,
      exit_code: exitCode,
      status: (phase === "completed" ? (exitCode === 0 ? "completed" : "failed") : "in_progress") as "completed" | "failed" | "in_progress",
    },
  };
}

function createFileChangeItem(
  changes: Array<{ path: string; kind: "add" | "delete" | "update" }>,
  status: "completed" | "failed" = "completed"
) {
  return {
    type: "item.completed" as const,
    item: {
      id: "file-1",
      type: "file_change" as const,
      changes,
      status,
    },
  };
}

function createMcpToolCallItem(
  phase: "started" | "completed" = "completed",
  result?: unknown
) {
  return {
    type: `item.${phase}` as "item.started" | "item.completed",
    item: {
      id: "mcp-1",
      type: "mcp_tool_call" as const,
      server: "github",
      tool: "search_issues",
      arguments: { query: "bug" },
      result: result ?? undefined,
      status: (phase === "completed" ? "completed" : "in_progress") as "completed" | "in_progress",
    },
  };
}

function createErrorItem(message: string) {
  return {
    type: "item.completed" as const,
    item: {
      id: "err-1",
      type: "error" as const,
      message,
    },
  };
}

// ============================================================================
// CodexAgent Tests
// ============================================================================

describe("CodexAgent", () => {
  it("implements AgentProvider interface", () => {
    const agent = new CodexAgent();
    expect(agent.type).toBe("codex");
    expect(typeof agent.executeChat).toBe("function");
    expect(typeof agent.forceStop).toBe("function");
    expect(typeof agent.cleanup).toBe("function");
    expect(typeof agent.supports).toBe("function");
    expect(typeof agent.getSessionId).toBe("function");
    expect(typeof agent.setSessionId).toBe("function");
    expect(typeof agent.getSdkTools).toBe("function");
  });

  it("reports correct feature support", () => {
    const agent = new CodexAgent();
    expect(agent.supports("extended_thinking")).toBe(false);
    expect(agent.supports("vision")).toBe(true);
    expect(agent.supports("native_mcp")).toBe(true);
    expect(agent.supports("streaming")).toBe(true);
    expect(agent.supports("tool_choice")).toBe(true);
  });

  it("manages session ID (thread ID)", () => {
    const agent = new CodexAgent();
    expect(agent.getSessionId()).toBeNull();

    agent.setSessionId("thread-abc-123");
    expect(agent.getSessionId()).toBe("thread-abc-123");

    agent.setSessionId(null);
    expect(agent.getSessionId()).toBeNull();
  });

  it("returns empty SDK tools initially", () => {
    const agent = new CodexAgent();
    expect(agent.getSdkTools()).toEqual([]);
  });

  it("forceStop does not throw when no thread exists", () => {
    const agent = new CodexAgent();
    expect(() => agent.forceStop()).not.toThrow();
  });

  it("cleanup does not throw when no thread exists", async () => {
    const agent = new CodexAgent();
    await expect(agent.cleanup()).resolves.toBeUndefined();
  });

  it("getLastStderrOutput returns empty array", () => {
    const agent = new CodexAgent();
    expect(agent.getLastStderrOutput()).toEqual([]);
  });

  it("getStreamHealthTriggered returns false", () => {
    const agent = new CodexAgent();
    expect(agent.getStreamHealthTriggered()).toBe(false);
  });
});

// ============================================================================
// Codex Event Normalizer Tests
// ============================================================================

describe("Codex Event Normalizer", () => {
  describe("thread.started", () => {
    it("emits status event", () => {
      const events = convertThreadStarted(createThreadStartedEvent());
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("status");
    });
  });

  describe("turn.started", () => {
    it("emits status event", () => {
      const events = convertTurnStarted();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("status");
    });
  });

  describe("turn.completed", () => {
    it("emits complete event with usage", () => {
      const events = convertTurnCompleted(createTurnCompletedEvent());
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.type).toBe("complete");
      if (event.type === "complete") {
        expect(event.usage).toBeDefined();
        expect(event.usage!.inputTokens).toBe(100);
        expect(event.usage!.outputTokens).toBe(50);
        expect(event.usage!.cacheReadTokens).toBe(10);
      }
    });
  });

  describe("turn.failed", () => {
    it("emits typed_error event", () => {
      const events = convertTurnFailed(createTurnFailedEvent("API error"));
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.type).toBe("typed_error");
      if (event.type === "typed_error") {
        expect(event.error.code).toBe("provider_error");
        expect(event.error.message).toBe("API error");
        expect(event.error.canRetry).toBe(true);
      }
    });
  });

  describe("thread error", () => {
    it("emits error event", () => {
      const events = convertThreadError({ type: "error", message: "Fatal error" });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("error");
      if (events[0].type === "error") {
        expect(events[0].message).toBe("Fatal error");
      }
    });
  });

  describe("agent_message items", () => {
    it("emits text_delta for started phase", () => {
      const events = convertItemStarted(createAgentMessageItem("Hello", "started") as any);
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe("text_delta");
    });

    it("emits text_complete for completed phase", () => {
      const events = convertItemCompleted(createAgentMessageItem("Hello world", "completed") as any);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("text_complete");
      if (events[0].type === "text_complete") {
        expect(events[0].text).toBe("Hello world");
      }
    });
  });

  describe("command_execution items", () => {
    it("emits tool_start for started phase", () => {
      const events = convertItemStarted(createCommandExecutionItem("ls -la", "started") as any);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("tool_start");
      if (events[0].type === "tool_start") {
        expect(events[0].toolName).toBe("Bash");
        expect(events[0].input).toEqual({ command: "ls -la" });
      }
    });

    it("emits tool_result for completed phase", () => {
      const events = convertItemCompleted(createCommandExecutionItem("ls -la", "completed", 0, "file1.ts\nfile2.ts") as any);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("tool_result");
      if (events[0].type === "tool_result") {
        expect(events[0].toolName).toBe("Bash");
        expect(events[0].result).toBe("file1.ts\nfile2.ts");
        expect(events[0].isError).toBe(false);
      }
    });

    it("marks failed commands as errors", () => {
      const events = convertItemCompleted(createCommandExecutionItem("bad-cmd", "completed", 1, "command not found") as any);
      expect(events).toHaveLength(1);
      if (events[0].type === "tool_result") {
        expect(events[0].isError).toBe(true);
      }
    });
  });

  describe("file_change items", () => {
    it("emits tool_start and tool_result pairs for each change", () => {
      const events = convertItemCompleted(createFileChangeItem([
        { path: "src/index.ts", kind: "update" },
        { path: "src/new.ts", kind: "add" },
      ]) as any);
      expect(events).toHaveLength(4);
      expect(events[0].type).toBe("tool_start");
      expect(events[1].type).toBe("tool_result");
      expect(events[2].type).toBe("tool_start");
      expect(events[3].type).toBe("tool_result");

      if (events[0].type === "tool_start") {
        expect(events[0].toolName).toBe("Edit");
      }
      if (events[2].type === "tool_start") {
        expect(events[2].toolName).toBe("Write");
      }
    });

    it("uses Delete for delete changes", () => {
      const events = convertItemCompleted(createFileChangeItem([
        { path: "src/old.ts", kind: "delete" },
      ]) as any);
      expect(events).toHaveLength(2);
      if (events[0].type === "tool_start") {
        expect(events[0].toolName).toBe("Delete");
      }
    });
  });

  describe("mcp_tool_call items", () => {
    it("emits tool_start for started phase", () => {
      const events = convertItemStarted(createMcpToolCallItem("started") as any);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("tool_start");
      if (events[0].type === "tool_start") {
        expect(events[0].toolName).toBe("github__search_issues");
        expect(events[0].input).toEqual({ query: "bug" });
      }
    });

    it("emits tool_result for completed phase", () => {
      const events = convertItemCompleted(createMcpToolCallItem("completed", { content: [{ type: "text", text: "found 3 issues" }], structured_content: null }) as any);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("tool_result");
      if (events[0].type === "tool_result") {
        expect(events[0].toolName).toBe("github__search_issues");
        expect(events[0].isError).toBe(false);
      }
    });
  });

  describe("error items", () => {
    it("emits error event", () => {
      const events = convertItemCompleted(createErrorItem("Something went wrong") as any);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("error");
      if (events[0].type === "error") {
        expect(events[0].message).toBe("Something went wrong");
      }
    });
  });

  describe("convertThreadEvent dispatch", () => {
    it("handles all event types", () => {
      expect(convertThreadEvent({ type: "thread.started", thread_id: "t1" })).toHaveLength(1);
      expect(convertThreadEvent({ type: "turn.started" })).toHaveLength(1);
      expect(convertThreadEvent({ type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 } })).toHaveLength(1);
      expect(convertThreadEvent({ type: "turn.failed", error: { message: "fail" } })).toHaveLength(1);
      expect(convertThreadEvent({ type: "error", message: "err" })).toHaveLength(1);
    });
  });
});

// ============================================================================
// Model Detection Tests
// ============================================================================

describe("Model Detection", () => {
  describe("isCodexModel", () => {
    it("detects Codex models", () => {
      expect(isCodexModel("codex-1")).toBe(true);
      expect(isCodexModel("gpt-4.1")).toBe(true);
      expect(isCodexModel("o3")).toBe(true);
    });

    it("does not match Claude models", () => {
      expect(isCodexModel("claude-sonnet-4-5-20250929")).toBe(false);
      expect(isCodexModel("claude-opus-4-6")).toBe(false);
    });
  });

  describe("isClaudeModel", () => {
    it("detects Claude models", () => {
      expect(isClaudeModel("claude-sonnet-4-5-20250929")).toBe(true);
      expect(isClaudeModel("claude-opus-4-6")).toBe(true);
    });

    it("does not match Codex models", () => {
      expect(isClaudeModel("codex-1")).toBe(false);
      expect(isClaudeModel("gpt-4.1")).toBe(false);
    });
  });

  describe("detectProviderFromModel", () => {
    it("returns codex for Codex models", () => {
      expect(detectProviderFromModel("codex-1")).toBe("codex");
      expect(detectProviderFromModel("gpt-4.1")).toBe("codex");
      expect(detectProviderFromModel("o3")).toBe("codex");
    });

    it("returns claude for Claude models", () => {
      expect(detectProviderFromModel("claude-sonnet-4-5-20250929")).toBe("claude");
      expect(detectProviderFromModel("claude-opus-4-6")).toBe("claude");
    });

    it("defaults to claude for unknown models", () => {
      expect(detectProviderFromModel("some-unknown-model")).toBe("claude");
    });
  });

  describe("getModelsForProvider", () => {
    it("returns Claude models for claude provider", () => {
      const models = getModelsForProvider("claude");
      expect(models.length).toBe(CLAUDE_MODELS.length);
      expect(models.every(m => m.provider === "claude")).toBe(true);
    });

    it("returns Codex models for codex provider", () => {
      const models = getModelsForProvider("codex");
      expect(models.length).toBe(CODEX_MODELS.length);
      expect(models.every(m => m.provider === "codex")).toBe(true);
    });
  });
});
