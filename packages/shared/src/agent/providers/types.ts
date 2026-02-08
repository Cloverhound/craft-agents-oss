import type { AgentEvent } from "@craft-agent/core/types";
import type { ThinkingLevel } from "../thinking-levels.ts";

export type ProviderType = "claude" | "codex";

export type ProviderFeature =
  | "extended_thinking"
  | "vision"
  | "native_mcp"
  | "tool_choice"
  | "streaming";

export interface AgentProvider {
  readonly type: ProviderType;

  executeChat(config: ChatExecutionConfig): AsyncGenerator<AgentEvent>;

  forceStop(): void;

  cleanup(): Promise<void>;

  supports(feature: ProviderFeature): boolean;

  getSessionId(): string | null;
  setSessionId(id: string | null): void;

  getSdkTools(): string[];

  getLastStderrOutput?(): string[];
  getStreamHealthTriggered?(): boolean;
}

export type ProviderMcpServers = Record<string, unknown>;

export type ProviderSystemPrompt = string | Record<string, unknown>;

export type ProviderHooks = unknown;

export type ProviderMessage = unknown;

export type MessageDelivery =
  | { mode: "text"; text: string }
  | { mode: "sdk_message"; sdkMessage: ProviderMessage }
  | { mode: "slash_command"; text: string };

export interface ChatExecutionConfig {
  delivery: MessageDelivery;

  model: string;
  modelConfig: string;
  isMiniAgent: boolean;
  thinkingLevel: ThinkingLevel;
  ultrathink: boolean;
  permissionMode?: string;

  mcpServers: ProviderMcpServers;
  systemPrompt: ProviderSystemPrompt;

  sessionId: string;
  sdkCwd: string;
  resumeSessionId: string | null;
  pendingResumeAt: string | null;
  isRetry: boolean;

  hooks: ProviderHooks;

  workspaceRootPath: string;
  disallowedTools: string[];

  onSessionIdUpdate?: (id: string) => void;
  onDebug?: (msg: string) => void;
}

export interface ProviderCapabilities {
  maxContextTokens: number;
  supportsThinking: boolean;
  supportsVision: boolean;
  supportsNativeMcp: boolean;
  supportedFileTypes: string[];
}
