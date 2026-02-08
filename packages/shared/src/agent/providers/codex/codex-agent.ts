/**
 * CodexAgent — OpenAI Codex SDK Provider Implementation
 *
 * Implements the AgentProvider interface using the @openai/codex-sdk.
 * Manages the Codex client lifecycle, Thread creation/resumption,
 * and converts Codex ThreadEvents to AgentEvents via event-normalizer.
 *
 * CraftAgent (the orchestrator) delegates SDK work here via executeChat().
 */

import {
  Codex,
  type Thread,
  type ThreadOptions,
  type CodexOptions,
  type ThreadEvent,
  type ApprovalMode,
  type SandboxMode,
} from "@openai/codex-sdk";
import type { AgentEvent } from "@craft-agent/core/types";
import type { AgentProvider, ChatExecutionConfig, ProviderFeature } from "../types.ts";
import { convertThreadEvent } from "./event-normalizer.ts";
import { isCodexModel } from "../../../config/models.ts";
import { debug } from "../../../utils/debug.ts";

function mapPermissionMode(permissionMode?: string): ApprovalMode {
  switch (permissionMode) {
    case "allow-all":
      return "never";
    case "ask":
      return "on-failure";
    case "safe":
    default:
      return "on-failure";
  }
}

export class CodexAgent implements AgentProvider {
  readonly type = "codex" as const;

  private codex: Codex | null = null;
  private thread: Thread | null = null;
  private threadId: string | null = null;
  private sdkTools: string[] = [];

  async *executeChat(config: ChatExecutionConfig): AsyncGenerator<AgentEvent> {
    if (!this.codex) {
      const codexOptions: CodexOptions = {};
      if (config.workspaceRootPath) {
        codexOptions.env = {
          ...process.env as Record<string, string>,
        };
      }
      this.codex = new Codex(codexOptions);
      debug("[CodexAgent] Created Codex client");
    }

    const codexModel = config.model && isCodexModel(config.model) ? config.model : undefined;
    debug(`[CodexAgent] Model: ${codexModel ?? "(default)"}`);
    const threadOptions: ThreadOptions = {
      model: codexModel,
      workingDirectory: config.workspaceRootPath,
      sandboxMode: "workspace-write" as SandboxMode,
      approvalPolicy: mapPermissionMode(config.permissionMode),
      skipGitRepoCheck: true,
    };

    if (config.resumeSessionId && !config.isRetry && this.threadId) {
      debug(`[CodexAgent] Resuming thread: ${this.threadId}`);
      this.thread = this.codex.resumeThread(this.threadId);
    } else {
      debug("[CodexAgent] Starting new thread");
      this.thread = this.codex.startThread(threadOptions);
    }

    let prompt: string;
    switch (config.delivery.mode) {
      case "text":
        prompt = config.delivery.text;
        break;
      case "slash_command":
        prompt = config.delivery.text;
        break;
      case "sdk_message":
        prompt = String(config.delivery.sdkMessage ?? "");
        break;
      default:
        prompt = "";
    }

    if (config.systemPrompt && typeof config.systemPrompt === "string") {
      prompt = `${config.systemPrompt}\n\n${prompt}`;
    }

    debug(`[CodexAgent] Running streamed turn with prompt length: ${prompt.length}`);

    const { events } = await this.thread.runStreamed(prompt);

    for await (const event of events) {
      const threadEvent = event as ThreadEvent;

      if (threadEvent.type === "thread.started") {
        const startedEvent = threadEvent as { thread_id: string };
        if (startedEvent.thread_id) {
          this.threadId = startedEvent.thread_id;
          config.onSessionIdUpdate?.(startedEvent.thread_id);
          debug(`[CodexAgent] Thread ID: ${this.threadId}`);
        }
      }

      const agentEvents = convertThreadEvent(threadEvent);
      for (const agentEvent of agentEvents) {
        yield agentEvent;
      }
    }
  }

  forceStop(): void {
    debug("[CodexAgent] Force stop requested");
    this.thread = null;
  }

  async cleanup(): Promise<void> {
    debug("[CodexAgent] Cleanup");
    this.thread = null;
    this.codex = null;
  }

  supports(feature: ProviderFeature): boolean {
    return ({
      extended_thinking: false,
      vision: true,
      native_mcp: true,
      tool_choice: true,
      streaming: true,
    } as Record<ProviderFeature, boolean>)[feature] ?? false;
  }

  getSessionId(): string | null {
    return this.threadId;
  }

  setSessionId(id: string | null): void {
    this.threadId = id;
  }

  getSdkTools(): string[] {
    return this.sdkTools;
  }

  getLastStderrOutput(): string[] {
    return [];
  }

  getStreamHealthTriggered(): boolean {
    return false;
  }
}
