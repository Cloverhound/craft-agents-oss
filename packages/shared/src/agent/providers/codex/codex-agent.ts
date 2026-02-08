/**
 * CodexAgent — OpenAI Codex SDK Provider Implementation
 *
 * Implements the AgentProvider interface using the @openai/codex-sdk.
 * Manages the Codex client lifecycle, Thread creation/resumption,
 * and converts Codex ThreadEvents to AgentEvents via event-normalizer.
 *
 * CraftAgent (the orchestrator) delegates SDK work here via executeChat().
 */

import type { AgentEvent } from "@craft-agent/core/types";
import type { AgentProvider, ChatExecutionConfig, ProviderFeature } from "../types.ts";
import { convertThreadEvent } from "./event-normalizer.ts";
import { isCodexModel } from "../../../config/models.ts";
import { debug } from "../../../utils/debug.ts";

type ApprovalMode = "never" | "on-request" | "untrusted" | "on-failure";

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

async function loadCodexSdk() {
  return await import("@openai/codex-sdk");
}

export class CodexAgent implements AgentProvider {
  readonly type = "codex" as const;

  private codex: unknown = null;
  private thread: unknown = null;
  private threadId: string | null = null;
  private sdkTools: string[] = [];

  async *executeChat(config: ChatExecutionConfig): AsyncGenerator<AgentEvent> {
    const sdk = await loadCodexSdk();

    if (!this.codex) {
      const codexOptions: Record<string, unknown> = {};
      if (config.workspaceRootPath) {
        codexOptions.env = {
          ...process.env as Record<string, string>,
        };
      }
      this.codex = new sdk.Codex(codexOptions);
      debug("[CodexAgent] Created Codex client");
    }

    const codexClient = this.codex as InstanceType<typeof sdk.Codex>;
    const codexModel = config.model && isCodexModel(config.model) ? config.model : undefined;
    debug(`[CodexAgent] Model: ${codexModel ?? "(default)"}`);
    const threadOptions = {
      model: codexModel,
      workingDirectory: config.workspaceRootPath,
      sandboxMode: "workspace-write",
      approvalPolicy: mapPermissionMode(config.permissionMode),
      skipGitRepoCheck: true,
    };

    if (config.resumeSessionId && !config.isRetry && this.threadId) {
      debug(`[CodexAgent] Resuming thread: ${this.threadId}`);
      this.thread = codexClient.resumeThread(this.threadId);
    } else {
      debug("[CodexAgent] Starting new thread");
      this.thread = codexClient.startThread(threadOptions as Parameters<typeof codexClient.startThread>[0]);
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

    const activeThread = this.thread as InstanceType<ReturnType<typeof codexClient.startThread>["constructor"]> & { runStreamed: (prompt: string) => Promise<{ events: AsyncIterable<unknown> }> };
    const { events } = await activeThread.runStreamed(prompt);

    for await (const event of events) {
      const threadEvent = event as { type: string; thread_id?: string; [key: string]: unknown };

      if (threadEvent.type === "thread.started") {
        if (threadEvent.thread_id) {
          this.threadId = threadEvent.thread_id as string;
          config.onSessionIdUpdate?.(this.threadId);
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
