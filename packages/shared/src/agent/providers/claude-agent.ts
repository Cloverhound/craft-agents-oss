/**
 * ClaudeAgent — Claude SDK Provider Implementation
 *
 * Handles all Claude Agent SDK interaction: SessionRunner lifecycle,
 * SDK Options construction, message sending, stream health monitoring,
 * and SDK message-to-AgentEvent conversion via event-normalizer.
 *
 * CraftAgent (the orchestrator) delegates SDK work here via executeChat().
 */

import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@craft-agent/core/types";
import type { AgentProvider, ChatExecutionConfig, ProviderFeature } from "./types.ts";
import { SessionRunner, ForceStopError } from "../session-runner.ts";
import { getDefaultOptions } from "../options.ts";
import { isClaudeModel } from "../../config/models.ts";
import { getThinkingTokens } from "../thinking-levels.ts";
import { debug } from "../../utils/debug.ts";
import {
  convertSDKMessage,
  ToolIndex,
  type EventNormalizerContext,
} from "./event-normalizer.ts";

// Re-export ForceStopError so CraftAgent can catch it
export { ForceStopError };

export class ClaudeAgent implements AgentProvider {
  readonly type = "claude" as const;

  private sessionRunner: SessionRunner | null = null;
  private sessionId: string | null = null;

  private streamHealthErrorCount = 0;
  private streamHealthTriggered = false;
  private streamHealthStallTimer: ReturnType<typeof setInterval> | null = null;

  private lastStderrOutput: string[] = [];
  private sdkTools: string[] = [];
  private lastAssistantUsage: {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  } | null = null;
  private cachedContextWindow?: number;

  async *executeChat(config: ChatExecutionConfig): AsyncGenerator<AgentEvent> {
    this.lastStderrOutput = [];
    this.streamHealthErrorCount = 0;
    this.streamHealthTriggered = false;
    this.clearStreamHealthStallTimer();

    const options = this.buildOptions(config);
    const runner = await this.ensureRunner(options, config);

    this.sendMessage(runner, config);

    const toolIndex = new ToolIndex();
    const emittedToolStarts = new Set<string>();
    const activeParentTools = new Set<string>();

    let pendingTextForStopReason: string | null = null;
    let pendingUuidForStopReason: string | null = null;
    let currentTurnId: string | null = null;
    let activeToolCount = 0;
    let isCompacting = false;

    const normalizerContext: EventNormalizerContext = {
      lastAssistantUsage: this.lastAssistantUsage,
      setLastAssistantUsage: (usage) => {
        this.lastAssistantUsage = usage;
        normalizerContext.lastAssistantUsage = usage;
      },
      cachedContextWindow: this.cachedContextWindow,
      setCachedContextWindow: (cw) => {
        this.cachedContextWindow = cw;
        normalizerContext.cachedContextWindow = cw;
      },
      sdkTools: this.sdkTools,
      setSdkTools: (tools) => {
        this.sdkTools = tools;
        normalizerContext.sdkTools = tools;
      },
      sessionId: this.sessionId,
      onDebug: config.onDebug,
    };

    const STALL_TIMEOUT_MS = 90_000;
    const resetStallTimer = () => {
      this.clearStreamHealthStallTimer();
      if (activeToolCount > 0 || isCompacting) return;
      this.streamHealthStallTimer = setInterval(() => {
        if (this.sessionRunner && !this.streamHealthTriggered) {
          debug("[StreamHealth] Stall detected — no SDK events for 90s, force-stopping runner");
          this.streamHealthTriggered = true;
          this.forceStopRunner();
        }
      }, STALL_TIMEOUT_MS);
    };
    resetStallTimer();

    for await (const message of runner.receiveUntilTurnComplete()) {
      if ("type" in message && message.type === "system" && "subtype" in message) {
        if ((message as any).subtype === "status" && (message as any).status === "compacting") {
          isCompacting = true;
          this.clearStreamHealthStallTimer();
        } else if ((message as any).subtype === "compact_boundary") {
          isCompacting = false;
        }
      }

      resetStallTimer();

      if ("type" in message && message.type === "assistant" && "message" in message) {
        const assistantMsg = message.message as { content?: unknown[] };
        if (assistantMsg.content && Array.isArray(assistantMsg.content) && assistantMsg.content.length > 0) {
          // Track that we received assistant content (CraftAgent uses this for empty response detection)
        }
      }
      if ("type" in message && message.type === "stream_event" && "event" in message) {
        const event = (message as { event: { type: string } }).event;
        if (event.type === "content_block_delta" || event.type === "message_start") {
          // Track assistant content via stream events
        }
      }

      if ("session_id" in message && message.session_id && message.session_id !== this.sessionId) {
        this.sessionId = message.session_id;
        normalizerContext.sessionId = this.sessionId;
        config.onSessionIdUpdate?.(message.session_id);
      }

      const events = await convertSDKMessage(
        message,
        toolIndex,
        emittedToolStarts,
        activeParentTools,
        pendingTextForStopReason,
        (text) => { pendingTextForStopReason = text; },
        currentTurnId,
        (id) => { currentTurnId = id; },
        pendingUuidForStopReason,
        (uuid) => { pendingUuidForStopReason = uuid; },
        normalizerContext
      );

      for (const event of events) {
        if (event.type === "tool_start") {
          activeToolCount++;
          this.clearStreamHealthStallTimer();
        } else if (event.type === "tool_result") {
          activeToolCount = Math.max(0, activeToolCount - 1);
          resetStallTimer();
        }

        yield event;
      }
    }

    this.clearStreamHealthStallTimer();

    if (pendingTextForStopReason) {
      yield { type: "text_complete", text: pendingTextForStopReason, isIntermediate: false, turnId: currentTurnId || undefined };
      pendingTextForStopReason = null;
    }
  }

  forceStop(): void {
    this.forceStopRunner();
  }

  async cleanup(): Promise<void> {
    this.forceStopRunner();
    this.clearStreamHealthStallTimer();
  }

  supports(feature: ProviderFeature): boolean {
    return ({
      extended_thinking: true,
      vision: true,
      native_mcp: true,
      tool_choice: true,
      streaming: true,
    } as Record<ProviderFeature, boolean>)[feature] ?? false;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  setSessionId(id: string | null): void {
    this.sessionId = id;
  }

  getSdkTools(): string[] {
    return this.sdkTools;
  }

  getLastStderrOutput(): string[] {
    return this.lastStderrOutput;
  }

  getStreamHealthTriggered(): boolean {
    return this.streamHealthTriggered;
  }

  private buildOptions(config: ChatExecutionConfig): Options {
    const isClaude = isClaudeModel(config.model);
    const useAnthropicBetas = isClaude;
    const thinkingTokens = getThinkingTokens(
      config.ultrathink ? "max" : config.thinkingLevel,
      config.modelConfig
    );

    return {
      ...getDefaultOptions(),
      model: config.model,
      stderr: (data: string) => {
        debug("[SDK stderr]", data);
        console.error("[SDK stderr]", data);
        this.lastStderrOutput.push(data);
        if (this.lastStderrOutput.length > 20) {
          this.lastStderrOutput.shift();
        }

        if (data.includes("Error in hook callback") && data.includes("Stream closed")) {
          this.streamHealthErrorCount++;
          debug(`[StreamHealth] Hook stream error #${this.streamHealthErrorCount}`);
          if (this.streamHealthErrorCount >= 3 && this.sessionRunner && !this.streamHealthTriggered) {
            debug("[StreamHealth] Death spiral detected — force-stopping runner for auto-recovery");
            this.streamHealthTriggered = true;
            this.forceStopRunner();
          }
        } else if (data.includes("Error in hook callback")) {
          // Mid-pattern, don't reset
        } else {
          this.streamHealthErrorCount = 0;
        }
      },
      ...(useAnthropicBetas ? { betas: ["advanced-tool-use-2025-11-20"] as any } : {}),
      maxThinkingTokens: config.isMiniAgent ? 0 : (isClaude ? thinkingTokens : 0),
      systemPrompt: config.systemPrompt,
      cwd: config.sdkCwd,
      includePartialMessages: true,
      tools: config.isMiniAgent
        ? ["Read", "Edit", "Write", "Glob", "Grep", "Bash"]
        : { type: "preset" as const, preset: "claude_code" as const },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      hooks: config.hooks,
      ...(!config.isRetry && config.resumeSessionId ? { resume: config.resumeSessionId } : {}),
      ...(config.pendingResumeAt ? {
        resumeSessionAt: config.pendingResumeAt,
        forkSession: true,
      } : {}),
      mcpServers: config.mcpServers,
      canUseTool: async (_toolName, input) => {
        return { behavior: "allow" as const, updatedInput: input as Record<string, unknown> };
      },
      disallowedTools: config.disallowedTools,
      plugins: [{ type: "local" as const, path: config.workspaceRootPath }],
    };
  }

  private async ensureRunner(
    options: Options,
    config: ChatExecutionConfig
  ): Promise<SessionRunner> {
    if (config.isRetry && this.sessionRunner) {
      debug("[ClaudeAgent] Force stopping existing SessionRunner for retry");
      this.sessionRunner.forceStop();
      this.sessionRunner = null;
    }

    if (this.sessionRunner?.isActive && !config.ultrathink) {
      return this.sessionRunner;
    }

    if (this.sessionRunner?.isActive && config.ultrathink) {
      debug("[ClaudeAgent] Stopping runner to enable ultrathink");
      this.sessionRunner.forceStop();
      this.sessionRunner = null;
    }

    debug("[ClaudeAgent] Creating new SessionRunner");
    this.sessionRunner = new SessionRunner({
      options,
      sessionId: this.sessionId || undefined,
      onDebug: (msg) => config.onDebug?.(msg),
      onUnexpectedExit: (error) => {
        debug(`[ClaudeAgent] SessionRunner unexpected exit: ${error.message}`);
        this.sessionRunner = null;
      },
    });

    await this.sessionRunner.start();
    debug("[ClaudeAgent] SessionRunner started");

    return this.sessionRunner;
  }

  private sendMessage(runner: SessionRunner, config: ChatExecutionConfig): void {
    switch (config.delivery.mode) {
      case "slash_command":
        debug(`[ClaudeAgent] Sending slash command: ${config.delivery.text}`);
        runner.sendText(config.delivery.text);
        break;
      case "sdk_message":
        runner.send(config.delivery.sdkMessage);
        break;
      case "text":
        runner.sendText(config.delivery.text);
        break;
    }
  }

  private forceStopRunner(): void {
    if (this.sessionRunner) {
      debug("[ClaudeAgent] Force stopping session runner");
      this.sessionRunner.forceStop();
      this.sessionRunner = null;
    }
  }

  private clearStreamHealthStallTimer(): void {
    if (this.streamHealthStallTimer) {
      clearInterval(this.streamHealthStallTimer);
      this.streamHealthStallTimer = null;
    }
  }
}
