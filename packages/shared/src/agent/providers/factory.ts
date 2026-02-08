import type { AgentProvider, ProviderType } from "./types.ts";
import { ClaudeAgent } from "./claude-agent.ts";

export function createProvider(type: ProviderType): AgentProvider {
  switch (type) {
    case "claude":
      return new ClaudeAgent();
    case "codex":
      throw new Error("Codex provider is not yet implemented (Phase 2)");
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}

export function getSupportedProviders(): ProviderType[] {
  return ["claude"];
}

export function getProviderDisplayName(type: ProviderType): string {
  const names: Record<ProviderType, string> = {
    claude: "Claude (Anthropic)",
    codex: "Codex (OpenAI)",
  };
  return names[type] ?? type;
}
