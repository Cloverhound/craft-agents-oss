/**
 * Event Normalizer — Claude SDK Message to AgentEvent Conversion
 *
 * Extracted from CraftAgent to isolate Claude SDK-specific event normalization.
 * These are standalone functions that receive dependencies as arguments rather
 * than relying on class instance state.
 *
 * In Phase 2, a parallel set of functions will handle Codex SDK events.
 */

import type { SDKMessage, SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@craft-agent/core/types";
import type { AgentError } from "../errors.ts";
import { ToolIndex, extractToolStarts, extractToolResults, type ContentBlock } from "../tool-matching.ts";

// Re-export ToolIndex for use by ClaudeAgent
export { ToolIndex };

export interface EventNormalizerContext {
  lastAssistantUsage: {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  } | null;
  setLastAssistantUsage: (usage: {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  }) => void;
  cachedContextWindow?: number;
  setCachedContextWindow: (cw: number) => void;
  sdkTools: string[];
  setSdkTools: (tools: string[]) => void;
  sessionId: string | null;
  onDebug?: (msg: string) => void;
}

/**
 * Detect the Windows ENOENT .claude/skills directory error from the Claude Code SDK.
 */
export function buildWindowsSkillsDirError(errorText: string): { type: "typed_error"; error: AgentError } | null {
  if (!errorText.includes("ENOENT") || !errorText.includes("skills")) {
    return null;
  }

  const pathMatch = errorText.match(/scandir\s+'([^']+)'/);
  const missingPath = pathMatch?.[1] || "C:\\ProgramData\\ClaudeCode\\.claude\\skills";

  return {
    type: "typed_error",
    error: {
      code: "unknown_error",
      title: "Windows Setup Required",
      message: `The SDK requires a directory that doesn't exist: ${missingPath} — Create this folder in File Explorer, then restart the app.`,
      details: [
        "PowerShell (run as Administrator):",
        `New-Item -ItemType Directory -Force -Path "${missingPath}"`,
      ],
      actions: [],
      canRetry: true,
      originalError: errorText,
    },
  };
}

/**
 * Parse the SDK debug log file for the actual API error details.
 * Reads from ~/.claude/debug/{sessionId}.txt
 */
export async function parseApiErrorFromDebugLog(
  sessionId: string | null
): Promise<{ errorType: string; message: string; requestId?: string } | null> {
  if (!sessionId) return null;

  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const debugFilePath = path.join(os.homedir(), ".claude", "debug", `${sessionId}.txt`);

  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!fs.existsSync(debugFilePath)) {
        if (attempt < 2) {
          await delay(50);
          continue;
        }
        return null;
      }

      const content = fs.readFileSync(debugFilePath, "utf-8");
      const lines = content.split("\n").slice(-50);

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        const errorMatch = line.match(/\[ERROR\].*?(\{.*\})/);
        if (errorMatch && errorMatch[1]) {
          try {
            const parsed = JSON.parse(errorMatch[1]);
            if (parsed?.error?.message) {
              return {
                errorType: parsed.error.type || "error",
                message: parsed.error.message,
                requestId: parsed.request_id,
              };
            }
          } catch {
            // Not valid JSON, continue searching
          }
        }
      }

      if (attempt < 2) {
        await delay(50);
      }
    } catch {
      if (attempt < 2) {
        await delay(50);
      }
    }
  }
  return null;
}

/**
 * Map SDK assistant message error codes to typed error events with user-friendly messages.
 */
export async function mapSDKErrorToTypedError(
  errorCode: SDKAssistantMessageError,
  sessionId: string | null
): Promise<{ type: "typed_error"; error: AgentError }> {
  const actualError = await parseApiErrorFromDebugLog(sessionId);
  const errorMap: Record<SDKAssistantMessageError, AgentError> = {
    "authentication_failed": {
      code: "invalid_api_key",
      title: "Authentication Failed",
      message: "Unable to authenticate with Anthropic. Your API key may be invalid or expired.",
      details: ["Check your API key in settings", "Ensure your API key has not been revoked"],
      actions: [
        { key: "s", label: "Settings", action: "settings" },
        { key: "r", label: "Retry", action: "retry" },
      ],
      canRetry: true,
      retryDelayMs: 1000,
    },
    "billing_error": {
      code: "billing_error",
      title: "Billing Error",
      message: "Your account has a billing issue.",
      details: ["Check your Anthropic account billing status"],
      actions: [
        { key: "s", label: "Update credentials", action: "settings" },
      ],
      canRetry: false,
    },
    "rate_limit": {
      code: "rate_limited",
      title: "Rate Limit Exceeded",
      message: "Too many requests. Please wait a moment before trying again.",
      details: ["Rate limits reset after a short period", "Consider upgrading your plan for higher limits"],
      actions: [
        { key: "r", label: "Retry", action: "retry" },
      ],
      canRetry: true,
      retryDelayMs: 5000,
    },
    "invalid_request": {
      code: "invalid_request",
      title: "Invalid Request",
      message: "The API rejected this request.",
      details: [
        ...(actualError ? [
          `Error: ${actualError.message}`,
          `Type: ${actualError.errorType}`,
          ...(actualError.requestId ? [`Request ID: ${actualError.requestId}`] : []),
        ] : []),
        "Try removing any attachments and resending",
        "Check if images are in a supported format (PNG, JPEG, GIF, WebP)",
      ],
      actions: [
        { key: "r", label: "Retry", action: "retry" },
      ],
      canRetry: true,
      retryDelayMs: 1000,
    },
    "server_error": {
      code: "network_error",
      title: "Connection Error",
      message: "Unable to connect to the API server. Check your internet connection.",
      details: [
        "Verify your network connection is active",
        "Check if the API endpoint is accessible",
        "Firewall or VPN may be blocking the connection",
      ],
      actions: [
        { key: "r", label: "Retry", action: "retry" },
      ],
      canRetry: true,
      retryDelayMs: 2000,
    },
    "unknown": {
      code: "unknown_error",
      title: "Unknown Error",
      message: "An unexpected error occurred.",
      details: [
        ...(actualError ? [
          `Error: ${actualError.message}`,
          `Type: ${actualError.errorType}`,
          ...(actualError.requestId ? [`Request ID: ${actualError.requestId}`] : []),
        ] : []),
        "This may be a temporary issue",
        "Check your network connection",
      ],
      actions: [
        { key: "r", label: "Retry", action: "retry" },
      ],
      canRetry: true,
      retryDelayMs: 2000,
    },
  };

  let error = errorMap[errorCode];

  if (errorCode === "unknown" && actualError) {
    const isProviderError =
      actualError.errorType === "api_error" ||
      actualError.errorType === "overloaded_error" ||
      actualError.message.toLowerCase().includes("internal server error") ||
      actualError.message.toLowerCase().includes("overloaded") ||
      actualError.message.toLowerCase().includes("service unavailable");

    if (isProviderError) {
      error = {
        code: "provider_error",
        title: "AI Provider Error",
        message: "The AI provider is experiencing issues. This is not a problem with your setup.",
        details: [
          ...(actualError.requestId ? [`Request ID: ${actualError.requestId}`] : []),
          "Check the provider status page for outages",
          "Try again in a few minutes",
          "Consider switching to a different AI provider in settings",
        ],
        actions: [
          { key: "r", label: "Retry", action: "retry" },
          { key: "s", label: "Settings", action: "settings" },
        ],
        canRetry: true,
        retryDelayMs: 5000,
      };
    }
  }

  return {
    type: "typed_error",
    error,
  };
}

/**
 * Convert a Claude SDK message to AgentEvent[].
 *
 * This is the core normalization function that maps SDK-specific message types
 * to the provider-agnostic AgentEvent union. State is passed in/out via
 * parameters and the context object to keep the function pure.
 */
export async function convertSDKMessage(
  message: SDKMessage,
  toolIndex: ToolIndex,
  emittedToolStarts: Set<string>,
  activeParentTools: Set<string>,
  pendingText: string | null,
  setPendingText: (text: string | null) => void,
  turnId: string | null,
  setTurnId: (id: string | null) => void,
  pendingUuid: string | null,
  setPendingUuid: (uuid: string | null) => void,
  context: EventNormalizerContext
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];

  if (context.onDebug) {
    const msgInfo = message.type === "user" && "tool_use_result" in message
      ? `user (tool_result for ${(message as any).parent_tool_use_id})`
      : message.type;
    context.onDebug(`SDK message: ${msgInfo}`);
  }

  switch (message.type) {
    case "assistant": {
      if ("error" in message && message.error) {
        const errorEvent = await mapSDKErrorToTypedError(message.error, context.sessionId);
        events.push(errorEvent);
        break;
      }

      if ("isReplay" in message && message.isReplay) {
        break;
      }

      const isSidechain = message.parent_tool_use_id !== null;
      if (!isSidechain && message.message.usage) {
        const usage = {
          input_tokens: message.message.usage.input_tokens,
          cache_read_input_tokens: message.message.usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: message.message.usage.cache_creation_input_tokens ?? 0,
        };
        context.setLastAssistantUsage(usage);

        const currentInputTokens =
          usage.input_tokens +
          usage.cache_read_input_tokens +
          usage.cache_creation_input_tokens;

        events.push({
          type: "usage_update",
          usage: {
            inputTokens: currentInputTokens,
            contextWindow: context.cachedContextWindow,
          },
        });
      }

      const content = message.message.content;

      let textContent = "";
      for (const block of content) {
        if (block.type === "text") {
          textContent += block.text;
        }
      }

      const sdkParentId = message.parent_tool_use_id;
      const toolStartEvents = extractToolStarts(
        content as ContentBlock[],
        sdkParentId,
        toolIndex,
        emittedToolStarts,
        turnId || undefined,
        activeParentTools,
      );

      for (const event of toolStartEvents) {
        if (event.type === "tool_start" && event.toolName === "Task") {
          activeParentTools.add(event.toolUseId);
        }
      }

      events.push(...toolStartEvents);

      if (textContent) {
        setPendingText(textContent);
        const sdkMsgUuid = "uuid" in message ? (message as any).uuid as string : undefined;
        if (sdkMsgUuid) {
          setPendingUuid(sdkMsgUuid);
        }
      }
      break;
    }

    case "stream_event": {
      const event = message.event;
      if (context.onDebug && event.type !== "content_block_delta") {
        context.onDebug(`stream_event: ${event.type}, content_type=${(event as any).content_block?.type || (event as any).delta?.type || "n/a"}`);
      }
      if (event.type === "message_start") {
        const messageId = (event as any).message?.id;
        if (messageId) {
          setTurnId(messageId);
        }
      }
      if (event.type === "message_delta") {
        const stopReason = (event as any).delta?.stop_reason;
        if (pendingText) {
          const isIntermediate = stopReason === "tool_use";
          events.push({ type: "text_complete", text: pendingText, isIntermediate, turnId: turnId || undefined, parentToolUseId: message.parent_tool_use_id || undefined, sdkUuid: pendingUuid || undefined });
          setPendingText(null);
          setPendingUuid(null);
        }
      }
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        events.push({ type: "text_delta", text: event.delta.text, turnId: turnId || undefined, parentToolUseId: message.parent_tool_use_id || undefined });
      } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        const toolBlock = event.content_block;
        const sdkParentId = message.parent_tool_use_id;
        const streamBlocks: ContentBlock[] = [{
          type: "tool_use" as const,
          id: toolBlock.id,
          name: toolBlock.name,
          input: (toolBlock.input ?? {}) as Record<string, unknown>,
        }];
        const streamEvents = extractToolStarts(
          streamBlocks,
          sdkParentId,
          toolIndex,
          emittedToolStarts,
          turnId || undefined,
          activeParentTools,
        );

        for (const evt of streamEvents) {
          if (evt.type === "tool_start" && evt.toolName === "Task") {
            activeParentTools.add(evt.toolUseId);
          }
        }

        events.push(...streamEvents);
      }
      break;
    }

    case "user": {
      if ("isReplay" in message && message.isReplay) {
        break;
      }

      if (message.tool_use_result !== undefined || ("message" in message && message.message)) {
        const msgContent = ("message" in message && message.message)
          ? ((message.message as { content?: unknown[] }).content ?? [])
          : [];
        const contentBlocks = (Array.isArray(msgContent) ? msgContent : []) as ContentBlock[];

        const sdkParentId = message.parent_tool_use_id;
        const toolUseResultValue = message.tool_use_result;

        const resultEvents = extractToolResults(
          contentBlocks,
          sdkParentId,
          toolUseResultValue,
          toolIndex,
          turnId || undefined,
        );

        for (const event of resultEvents) {
          if (event.type === "tool_result" && event.toolName === "Task") {
            activeParentTools.delete(event.toolUseId);
          }
        }

        events.push(...resultEvents);
      }
      break;
    }

    case "tool_progress": {
      const progress = message as {
        tool_use_id: string;
        tool_name: string;
        parent_tool_use_id: string | null;
        elapsed_time_seconds?: number;
      };

      if (progress.elapsed_time_seconds !== undefined) {
        events.push({
          type: "task_progress",
          toolUseId: progress.parent_tool_use_id || progress.tool_use_id,
          elapsedSeconds: progress.elapsed_time_seconds,
          turnId: turnId || undefined,
        });
      }

      if (!emittedToolStarts.has(progress.tool_use_id)) {
        const progressBlocks: ContentBlock[] = [{
          type: "tool_use" as const,
          id: progress.tool_use_id,
          name: progress.tool_name,
          input: {},
        }];
        const progressEvents = extractToolStarts(
          progressBlocks,
          progress.parent_tool_use_id,
          toolIndex,
          emittedToolStarts,
          turnId || undefined,
          activeParentTools,
        );

        for (const evt of progressEvents) {
          if (evt.type === "tool_start" && evt.toolName === "Task") {
            activeParentTools.add(evt.toolUseId);
          }
        }

        events.push(...progressEvents);
      }
      break;
    }

    case "result": {
      console.error(`[CraftAgent] result message: subtype=${message.subtype}, errors=${"errors" in message ? JSON.stringify((message as any).errors) : "none"}`);

      const modelUsageEntries = Object.values(message.modelUsage || {});
      const primaryModelUsage = modelUsageEntries[0];

      if (primaryModelUsage?.contextWindow) {
        context.setCachedContextWindow(primaryModelUsage.contextWindow);
      }

      let inputTokens: number;
      let cacheRead: number;
      let cacheCreation: number;

      if (context.lastAssistantUsage) {
        inputTokens = context.lastAssistantUsage.input_tokens +
                      context.lastAssistantUsage.cache_read_input_tokens +
                      context.lastAssistantUsage.cache_creation_input_tokens;
        cacheRead = context.lastAssistantUsage.cache_read_input_tokens;
        cacheCreation = context.lastAssistantUsage.cache_creation_input_tokens;
      } else {
        cacheRead = message.usage.cache_read_input_tokens ?? 0;
        cacheCreation = message.usage.cache_creation_input_tokens ?? 0;
        inputTokens = message.usage.input_tokens + cacheRead + cacheCreation;
      }

      const usage = {
        inputTokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        costUsd: message.total_cost_usd,
        contextWindow: primaryModelUsage?.contextWindow,
      };

      if (message.subtype === "success") {
        events.push({ type: "complete", usage });
      } else {
        const errorMsg = "errors" in message ? message.errors.join(", ") : "Query failed";

        const windowsError = buildWindowsSkillsDirError(errorMsg);
        if (windowsError) {
          events.push(windowsError);
        } else {
          events.push({ type: "error", message: errorMsg });
        }
        events.push({ type: "complete", usage });
      }
      break;
    }

    case "system": {
      if (message.subtype === "init") {
        if ("tools" in message && Array.isArray(message.tools)) {
          context.setSdkTools(message.tools);
          context.onDebug?.(`SDK init: captured ${message.tools.length} tools`);
        }
      } else if (message.subtype === "compact_boundary") {
        events.push({
          type: "info",
          message: "Compacted Conversation",
        });
      } else if (message.subtype === "status" && message.status === "compacting") {
        events.push({ type: "status", message: "Compacting conversation..." });
      }
      break;
    }

    case "auth_status": {
      if (message.error) {
        events.push({ type: "error", message: `Auth error: ${message.error}. Try running /auth to re-authenticate.` });
      }
      break;
    }

    default: {
      if (context.onDebug) {
        context.onDebug(`Unhandled SDK message type: ${(message as any).type}`);
      }
      break;
    }
  }

  return events;
}

/**
 * Check if a tool result error indicates a "tool not found" for an inactive source.
 * Used to detect when Claude tries to call a tool from a source that exists
 * but isn't currently active, so we can auto-activate and retry.
 */
export function detectInactiveSourceToolError(
  event: AgentEvent,
  toolIndex: ToolIndex,
  allSources: { config: { slug: string } }[],
  activeSourceServerNames: Set<string>
): { sourceSlug: string; toolName: string; input: unknown } | null {
  if (event.type !== "tool_result" || !event.isError) return null;

  const resultStr = typeof event.result === "string" ? event.result : "";

  let toolName: string | null = null;

  const noSuchToolMatch = resultStr.match(/No (?:such )?tool available:\s*([^\s<]+)/i);
  if (noSuchToolMatch?.[1]) {
    toolName = noSuchToolMatch[1];
  }

  if (!toolName) {
    const toolNotFoundMatch = resultStr.match(/Tool\s+['"`]([^'"`]+)['"`]\s+not found/i);
    if (toolNotFoundMatch?.[1]) {
      toolName = toolNotFoundMatch[1];
    }
  }

  if (!toolName) {
    const name = toolIndex.getName(event.toolUseId);
    if (name) {
      toolName = name;
    }
  }

  if (!toolName) return null;

  if (!toolName.startsWith("mcp__")) return null;

  const parts = toolName.split("__");
  if (parts.length < 3) return null;

  const sourceSlug = parts[1]!;

  const sourceExists = allSources.some((s) => s.config.slug === sourceSlug);
  const isActive = activeSourceServerNames.has(sourceSlug);

  if (sourceExists && !isActive) {
    const input = toolIndex.getInput(event.toolUseId);
    return { sourceSlug, toolName, input: input ?? {} };
  }

  return null;
}
