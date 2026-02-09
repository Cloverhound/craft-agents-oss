/**
 * CodexAgent — OpenAI Codex SDK Provider Implementation
 *
 * Implements the AgentProvider interface using the @openai/codex-sdk.
 * Manages the Codex client lifecycle, Thread creation/resumption,
 * and converts Codex ThreadEvents to AgentEvents via event-normalizer.
 *
 * Integrates Craft context via:
 *   - developer_instructions: system prompt adapted for Codex + skill catalog
 *   - mcp_servers: source MCP servers + session-scoped tools bridge
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
import type { AgentProvider, ChatExecutionConfig, ProviderFeature, ProviderSystemPrompt } from "../types.ts";
import { convertThreadEvent, setCodexModel, resetCodexNormalizerState } from "./event-normalizer.ts";
import { isCodexModel, DEFAULT_CODEX_MODEL } from "../../../config/models.ts";
import { debug } from "../../../utils/debug.ts";
import { loadAllSkills } from "../../../skills/storage.ts";
import type { LoadedSkill } from "../../../skills/types.ts";
import { mapSourceMcpServers } from "./codex-mcp-mapper.ts";
import { createCodexSessionTools, type CodexSessionToolCallbacks } from "./codex-session-tools.ts";
import type { CodexMcpServerHandle } from "../../../mcp/codex-mcp-bridge.ts";
import { join } from "path";

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

function extractDeveloperInstructions(systemPrompt: ProviderSystemPrompt): string | undefined {
  if (!systemPrompt) return undefined;

  let text: string;
  if (typeof systemPrompt === "string") {
    text = systemPrompt;
  } else {
    const obj = systemPrompt as Record<string, unknown>;
    if (obj.append && typeof obj.append === "string") {
      text = obj.append;
    } else {
      return undefined;
    }
  }

  text = text.replace(
    /\*\*SDK Plugin:\*\*.*?skill-slug`\./s,
    ""
  );
  text = text.replace(/powered by Claude Code/g, "powered by Codex");
  text = text.replace(/You are powered by Claude Code, so you/g, "You");
  text = text.replace(/Claude Code SDK plugin/g, "Codex");

  return text;
}

function buildSkillCatalog(skills: LoadedSkill[]): string {
  if (skills.length === 0) return "";

  const entries = skills.map((s) => {
    const skillMdPath = join(s.path, "SKILL.md");
    return `- **${s.metadata.name}** (${s.slug}): ${s.metadata.description}\n  Path: \`${skillMdPath}\``;
  });

  return [
    "\n## Available Skills",
    "",
    "The following skills are available in this workspace. To use a skill, read its SKILL.md file for full instructions.",
    "",
    ...entries,
    "",
  ].join("\n");
}

function discoverSkills(workspaceRootPath: string): LoadedSkill[] {
  try {
    const skills = loadAllSkills(workspaceRootPath, workspaceRootPath);
    debug(`[CodexAgent] Discovered ${skills.length} skills from workspace: ${workspaceRootPath}`);
    for (const s of skills) {
      debug(`[CodexAgent]   skill: ${s.slug} (${s.source}) at ${s.path}`);
    }
    return skills;
  } catch (err) {
    debug(`[CodexAgent] Skills discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export class CodexAgent implements AgentProvider {
  readonly type = "codex" as const;

  private codex: Codex | null = null;
  private thread: Thread | null = null;
  private threadId: string | null = null;
  private sdkTools: string[] = [];
  private sessionBridge: CodexMcpServerHandle | null = null;
  private sessionToolCallbacks: CodexSessionToolCallbacks = {};

  setSessionToolCallbacks(callbacks: CodexSessionToolCallbacks): void {
    this.sessionToolCallbacks = callbacks;
  }

  async *executeChat(config: ChatExecutionConfig): AsyncGenerator<AgentEvent> {
    if (!this.codex) {
      let developerInstructions = extractDeveloperInstructions(config.systemPrompt) ?? "";
      const skills = discoverSkills(config.workspaceRootPath);
      const skillCatalog = buildSkillCatalog(skills);
      if (skillCatalog) {
        developerInstructions += skillCatalog;
      }

      this.sessionBridge = await createCodexSessionTools(
        config.sessionId,
        config.workspaceRootPath,
        this.sessionToolCallbacks,
      );

      const sourceMcpServers = mapSourceMcpServers(config.mcpServers as Record<string, unknown>);

      const codexConfig: Record<string, any> = {};

      if (developerInstructions) {
        codexConfig.developer_instructions = developerInstructions;
      }

      const mcpServers: Record<string, any> = {
        ...sourceMcpServers,
        session: this.sessionBridge.config,
      };
      codexConfig.mcp_servers = mcpServers;

      const codexOptions: CodexOptions = {
        config: codexConfig,
        env: {
          ...process.env as Record<string, string>,
        },
      };

      this.codex = new Codex(codexOptions);
      resetCodexNormalizerState();
      debug("[CodexAgent] Created Codex client with context integration");
      debug(`[CodexAgent]   developer_instructions: ${developerInstructions ? `${developerInstructions.length} chars` : "none"}`);
      debug(`[CodexAgent]   skills: ${skills.length} (injected into developer_instructions)`);
      debug(`[CodexAgent]   mcp_servers: ${Object.keys(mcpServers).join(", ")}`);
    }

    const codexModel = config.model && isCodexModel(config.model) ? config.model : undefined;
    setCodexModel(codexModel ?? DEFAULT_CODEX_MODEL);
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
    if (this.sessionBridge) {
      try {
        await this.sessionBridge.close();
      } catch (err) {
        debug(`[CodexAgent] Bridge cleanup error: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.sessionBridge = null;
    }
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
