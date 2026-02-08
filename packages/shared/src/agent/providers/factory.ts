import type { AgentProvider, ProviderType } from "./types.ts";
import { ClaudeAgent } from "./claude/claude-agent.ts";
import { CodexAgent } from "./codex/codex-agent.ts";

export function createProvider(type: ProviderType): AgentProvider {
  switch (type) {
    case "claude":
      return new ClaudeAgent();
    case "codex":
      return new CodexAgent();
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}

export function getSupportedProviders(): ProviderType[] {
  return ["claude", "codex"];
}

export function getProviderDisplayName(type: ProviderType): string {
  const names: Record<ProviderType, string> = {
    claude: "Claude (Anthropic)",
    codex: "Codex (OpenAI)",
  };
  return names[type] ?? type;
}
