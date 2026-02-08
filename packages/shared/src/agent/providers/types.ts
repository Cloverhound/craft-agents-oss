import type { AgentEvent } from "@craft-agent/core/types";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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
}

export type MessageDelivery =
  | { mode: "text"; text: string }
  | { mode: "sdk_message"; sdkMessage: SDKUserMessage }
  | { mode: "slash_command"; text: string };

export interface ChatExecutionConfig {
  delivery: MessageDelivery;

  model: string;
  modelConfig: string;
  isClaude: boolean;
  isMiniAgent: boolean;
  thinkingLevel: ThinkingLevel;
  ultrathink: boolean;

  mcpServers: Options["mcpServers"];
  systemPrompt: Options["systemPrompt"];

  sessionId: string;
  sdkCwd: string;
  resumeSessionId: string | null;
  pendingResumeAt: string | null;
  isRetry: boolean;

  hooks: Options["hooks"];

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
