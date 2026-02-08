/**
 * Provider Abstraction Tests
 *
 * Validates the provider factory, ClaudeAgent implementation, CodexAgent implementation,
 * and event normalizer functions from the multi-provider refactoring.
 */

import { describe, it, expect } from "bun:test";
import { createProvider, getSupportedProviders, getProviderDisplayName } from "../providers/factory.ts";
import { ClaudeAgent } from "../providers/claude/claude-agent.ts";
import { CodexAgent } from "../providers/codex/codex-agent.ts";
import {
  mapSDKErrorToTypedError,
  buildWindowsSkillsDirError,
  detectInactiveSourceToolError,
  ToolIndex,
} from "../providers/claude/event-normalizer.ts";
import type { AgentProvider, ProviderType } from "../providers/types.ts";
import {
  getModelsForProvider,
  detectProviderFromModel,
  isClaudeModel,
  isCodexModel,
  CLAUDE_MODELS,
  CODEX_MODELS,
} from "../../config/models.ts";

describe("Provider Factory", () => {
  it("creates a ClaudeAgent for 'claude' type", () => {
    const provider = createProvider("claude");
    expect(provider).toBeInstanceOf(ClaudeAgent);
    expect(provider.type).toBe("claude");
  });

  it("creates a CodexAgent for 'codex' type", () => {
    const provider = createProvider("codex");
    expect(provider).toBeInstanceOf(CodexAgent);
    expect(provider.type).toBe("codex");
  });

  it("throws for unknown type", () => {
    expect(() => createProvider("unknown" as ProviderType)).toThrow("Unknown provider type");
  });

  it("getSupportedProviders returns both providers", () => {
    const supported = getSupportedProviders();
    expect(supported).toContain("claude");
    expect(supported).toContain("codex");
  });

  it("getProviderDisplayName returns human-readable names", () => {
    expect(getProviderDisplayName("claude")).toBe("Claude (Anthropic)");
    expect(getProviderDisplayName("codex")).toBe("Codex (OpenAI)");
  });
});

describe("ClaudeAgent", () => {
  it("implements AgentProvider interface", () => {
    const agent = new ClaudeAgent();
    expect(agent.type).toBe("claude");
    expect(typeof agent.executeChat).toBe("function");
    expect(typeof agent.forceStop).toBe("function");
    expect(typeof agent.cleanup).toBe("function");
    expect(typeof agent.supports).toBe("function");
    expect(typeof agent.getSessionId).toBe("function");
    expect(typeof agent.setSessionId).toBe("function");
    expect(typeof agent.getSdkTools).toBe("function");
  });

  it("supports expected features", () => {
    const agent = new ClaudeAgent();
    expect(agent.supports("extended_thinking")).toBe(true);
    expect(agent.supports("vision")).toBe(true);
    expect(agent.supports("native_mcp")).toBe(true);
    expect(agent.supports("streaming")).toBe(true);
  });

  it("manages session ID", () => {
    const agent = new ClaudeAgent();
    expect(agent.getSessionId()).toBeNull();

    agent.setSessionId("test-session-123");
    expect(agent.getSessionId()).toBe("test-session-123");

    agent.setSessionId(null);
    expect(agent.getSessionId()).toBeNull();
  });

  it("returns empty SDK tools initially", () => {
    const agent = new ClaudeAgent();
    expect(agent.getSdkTools()).toEqual([]);
  });

  it("forceStop does not throw when no runner exists", () => {
    const agent = new ClaudeAgent();
    expect(() => agent.forceStop()).not.toThrow();
  });

  it("cleanup does not throw when no runner exists", async () => {
    const agent = new ClaudeAgent();
    await expect(agent.cleanup()).resolves.toBeUndefined();
  });
});

describe("Event Normalizer — mapSDKErrorToTypedError", () => {
  it("maps authentication_failed to typed error", async () => {
    const result = await mapSDKErrorToTypedError("authentication_failed", null);
    expect(result.type).toBe("typed_error");
    expect(result.error.code).toBe("invalid_api_key");
    expect(result.error.canRetry).toBe(true);
  });

  it("maps billing_error to typed error", async () => {
    const result = await mapSDKErrorToTypedError("billing_error", null);
    expect(result.type).toBe("typed_error");
    expect(result.error.code).toBe("billing_error");
    expect(result.error.canRetry).toBe(false);
  });

  it("maps rate_limit to typed error", async () => {
    const result = await mapSDKErrorToTypedError("rate_limit", null);
    expect(result.type).toBe("typed_error");
    expect(result.error.code).toBe("rate_limited");
    expect(result.error.retryDelayMs).toBe(5000);
  });

  it("maps server_error to typed error", async () => {
    const result = await mapSDKErrorToTypedError("server_error", null);
    expect(result.type).toBe("typed_error");
    expect(result.error.code).toBe("network_error");
  });

  it("maps unknown to typed error", async () => {
    const result = await mapSDKErrorToTypedError("unknown", null);
    expect(result.type).toBe("typed_error");
    expect(result.error.code).toBe("unknown_error");
  });
});

describe("Event Normalizer — buildWindowsSkillsDirError", () => {
  it("returns null for unrelated errors", () => {
    expect(buildWindowsSkillsDirError("some random error")).toBeNull();
    expect(buildWindowsSkillsDirError("ENOENT: no such file")).toBeNull();
    expect(buildWindowsSkillsDirError("skills are missing")).toBeNull();
  });

  it("detects ENOENT + skills error", () => {
    const result = buildWindowsSkillsDirError("ENOENT: no such directory skills");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("typed_error");
    expect(result!.error.code).toBe("unknown_error");
    expect(result!.error.title).toBe("Windows Setup Required");
    expect(result!.error.canRetry).toBe(true);
  });

  it("extracts path from scandir error", () => {
    const result = buildWindowsSkillsDirError("Error: ENOENT: scandir 'C:\\ProgramData\\ClaudeCode\\.claude\\skills'");
    expect(result).not.toBeNull();
    expect(result!.error.message).toContain("C:\\ProgramData\\ClaudeCode\\.claude\\skills");
  });
});

describe("Event Normalizer — detectInactiveSourceToolError", () => {
  it("returns null for non-tool-result events", () => {
    const toolIndex = new ToolIndex();
    const result = detectInactiveSourceToolError(
      { type: "text_delta", text: "hello" } as any,
      toolIndex,
      [],
      new Set()
    );
    expect(result).toBeNull();
  });

  it("returns null for non-error tool results", () => {
    const toolIndex = new ToolIndex();
    const result = detectInactiveSourceToolError(
      { type: "tool_result", toolUseId: "test", toolName: "Read", result: "ok", isError: false } as any,
      toolIndex,
      [],
      new Set()
    );
    expect(result).toBeNull();
  });

  it("detects inactive source from error message", () => {
    const toolIndex = new ToolIndex();
    const allSources = [{ config: { slug: "slack" } }] as any;
    const activeSourceServerNames = new Set<string>();

    const result = detectInactiveSourceToolError(
      {
        type: "tool_result",
        toolUseId: "test-id",
        toolName: "mcp__slack__search",
        result: "No such tool available: mcp__slack__search",
        isError: true,
      } as any,
      toolIndex,
      allSources,
      activeSourceServerNames
    );

    expect(result).not.toBeNull();
    expect(result!.sourceSlug).toBe("slack");
    expect(result!.toolName).toBe("mcp__slack__search");
  });

  it("returns null when source is already active", () => {
    const toolIndex = new ToolIndex();
    const allSources = [{ config: { slug: "slack" } }] as any;
    const activeSourceServerNames = new Set<string>(["slack"]);

    const result = detectInactiveSourceToolError(
      {
        type: "tool_result",
        toolUseId: "test-id",
        toolName: "mcp__slack__search",
        result: "No such tool available: mcp__slack__search",
        isError: true,
      } as any,
      toolIndex,
      allSources,
      activeSourceServerNames
    );

    expect(result).toBeNull();
  });

  it("returns null for non-MCP tools", () => {
    const toolIndex = new ToolIndex();
    const result = detectInactiveSourceToolError(
      {
        type: "tool_result",
        toolUseId: "test-id",
        toolName: "Read",
        result: "File not found",
        isError: true,
      } as any,
      toolIndex,
      [],
      new Set()
    );

    expect(result).toBeNull();
  });
});

describe("ToolIndex", () => {
  it("registers and retrieves tool data", () => {
    const index = new ToolIndex();
    index.register("tool-1", "Read", { file_path: "/test" });

    expect(index.getName("tool-1")).toBe("Read");
    expect(index.getInput("tool-1")).toEqual({ file_path: "/test" });
  });

  it("returns undefined for unknown tool IDs", () => {
    const index = new ToolIndex();
    expect(index.getName("unknown")).toBeUndefined();
    expect(index.getInput("unknown")).toBeUndefined();
  });
});

describe("Model-Provider Mapping", () => {
  it("getModelsForProvider returns only Claude models for 'claude'", () => {
    const models = getModelsForProvider("claude");
    expect(models.length).toBe(CLAUDE_MODELS.length);
    for (const m of models) {
      expect(m.provider).toBe("claude");
    }
  });

  it("getModelsForProvider returns only Codex models for 'codex'", () => {
    const models = getModelsForProvider("codex");
    expect(models.length).toBe(CODEX_MODELS.length);
    for (const m of models) {
      expect(m.provider).toBe("codex");
    }
  });

  it("detectProviderFromModel identifies Claude models", () => {
    expect(detectProviderFromModel("claude-sonnet-4-5-20250929")).toBe("claude");
    expect(detectProviderFromModel("claude-opus-4-6")).toBe("claude");
    expect(detectProviderFromModel("claude-haiku-4-5-20251001")).toBe("claude");
  });

  it("detectProviderFromModel identifies Codex models", () => {
    expect(detectProviderFromModel("gpt-5.3-codex")).toBe("codex");
    expect(detectProviderFromModel("gpt-5.2-codex")).toBe("codex");
    expect(detectProviderFromModel("gpt-5.2")).toBe("codex");
  });

  it("detectProviderFromModel defaults to claude for unknown models", () => {
    expect(detectProviderFromModel("unknown-model")).toBe("claude");
  });

  it("isClaudeModel matches Claude model IDs", () => {
    expect(isClaudeModel("claude-sonnet-4-5-20250929")).toBe(true);
    expect(isClaudeModel("claude-opus-4-6")).toBe(true);
    expect(isClaudeModel("gpt-5.3-codex")).toBe(false);
    expect(isClaudeModel("gpt-5.2")).toBe(false);
  });

  it("isCodexModel matches Codex model IDs", () => {
    expect(isCodexModel("gpt-5.3-codex")).toBe(true);
    expect(isCodexModel("gpt-5.2-codex")).toBe(true);
    expect(isCodexModel("gpt-5.2")).toBe(true);
    expect(isCodexModel("claude-sonnet-4-5-20250929")).toBe(false);
  });
});

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

  it("supports expected features", () => {
    const agent = new CodexAgent();
    expect(agent.supports("extended_thinking")).toBe(false);
    expect(agent.supports("vision")).toBe(true);
    expect(agent.supports("native_mcp")).toBe(true);
    expect(agent.supports("streaming")).toBe(true);
  });

  it("manages session ID", () => {
    const agent = new CodexAgent();
    expect(agent.getSessionId()).toBeNull();

    agent.setSessionId("codex-thread-456");
    expect(agent.getSessionId()).toBe("codex-thread-456");

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
});
