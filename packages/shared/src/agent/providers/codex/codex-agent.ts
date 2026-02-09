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

/**
 * Maps a Craft permission mode to the corresponding Codex SDK sandbox and
 * approval settings. The Codex binary executes tools internally — Craft's
 * PreToolUse hooks cannot intercept native Codex tool calls. Permissions are
 * therefore enforced entirely by the Codex sandbox mode and approval policy.
 *
 * Craft allowlists (allowedBashPatterns, allowedWritePaths) are NOT applied
 * in Codex mode. OpenAI is working on a runtime hooks system that will allow
 * finer-grained control in the future.
 */
export function mapPermissionMode(permissionMode?: string): {
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalMode;
} {
  switch (permissionMode) {
    case "allow-all":
      return { sandboxMode: "danger-full-access", approvalPolicy: "never" };
    case "ask":
      return { sandboxMode: "workspace-write", approvalPolicy: "on-failure" };
    case "safe":
    default:
      return { sandboxMode: "read-only", approvalPolicy: "on-failure" };
  }
}

const PERMISSION_CONTEXT: Record<string, { displayName: string; description: string }> = {
  "allow-all": {
    displayName: "Execute",
    description:
      "Full access. All file operations, commands, and external access "
      + "(including paths outside the workspace and network) are allowed.",
  },
  "ask": {
    displayName: "Ask",
    description:
      "Workspace-write access. File reads anywhere and writes inside the workspace "
      + "directory are allowed. Writes outside the workspace, privileged system commands, "
      + "and external access are blocked by the OS-level sandbox.",
  },
  "safe": {
    displayName: "Explore",
    description:
      "Read-only access. All write operations — file creation, file modification, "
      + "and any command that writes to disk — are blocked by the OS-level sandbox. "
      + "Only read commands are allowed.",
  },
};

/**
 * Builds an XML-tagged session context block that is prepended to the user
 * prompt on each turn. Tells the model its current permission mode and what
 * to do when a command is blocked by the sandbox.
 */
export function buildPermissionContext(permissionMode?: string): string {
  const key = permissionMode ?? "safe";
  const ctx = PERMISSION_CONTEXT[key] ?? PERMISSION_CONTEXT["safe"];

  return [
    "<session_context>",
    `permissionMode: ${ctx.displayName}`,
    "",
    ctx.description,
    "",
    "If a command fails with a permission, access, or sandbox error, do NOT retry it or "
    + "attempt workarounds. Instead, explain to the user that the operation requires a higher "
    + "permission level and suggest they switch to "
    + (key === "safe" ? "Ask or Execute" : "Execute")
    + " mode (SHIFT+TAB) to proceed.",
    "",
    "Craft-level bash permission allowlists and write-path exceptions from permissions.json "
    + "are not enforced in Codex mode. The Codex SDK does not yet support runtime permission "
    + "hooks — OpenAI is working on adding this capability.",
    "</session_context>",
  ].join("\n");
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

      developerInstructions += "\n\n## Codex Permission Model\n\n"
        + "Permissions in Codex mode are enforced by the OS-level sandbox, not by Craft hooks. "
        + "Each turn includes a <session_context> block with the active permission mode and "
        + "what operations are allowed. Always check session_context before attempting operations "
        + "that may require write access.";

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
    const { sandboxMode, approvalPolicy } = mapPermissionMode(config.permissionMode);
    debug(`[CodexAgent] Model: ${codexModel ?? "(default)"}, sandbox: ${sandboxMode}, approval: ${approvalPolicy}`);
    const threadOptions: ThreadOptions = {
      model: codexModel,
      workingDirectory: config.sdkCwd,
      sandboxMode,
      approvalPolicy,
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

    const permissionContext = buildPermissionContext(config.permissionMode);
    prompt = `${permissionContext}\n\n${prompt}`;
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
