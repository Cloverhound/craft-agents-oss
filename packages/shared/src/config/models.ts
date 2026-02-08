/**
 * Centralized model definitions for the entire application.
 * Update model IDs here when new versions are released.
 */

import type { ProviderType } from '../agent/providers/types.ts';

export interface ModelDefinition {
  id: string;
  name: string;
  shortName: string;
  description: string;
  provider: ProviderType;
  /** Known context window size in tokens (used as fallback before SDK reports usage) */
  contextWindow?: number;
}

// ============================================
// USER-SELECTABLE MODELS (shown in UI)
// ============================================

export const CLAUDE_MODELS: ModelDefinition[] = [
  { id: 'claude-opus-4-6', name: 'Opus 4.6', shortName: 'Opus', description: 'Most capable', provider: 'claude', contextWindow: 200000 },
  { id: 'claude-sonnet-4-5-20250929', name: 'Sonnet 4.5', shortName: 'Sonnet', description: 'Balanced', provider: 'claude', contextWindow: 200000 },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', shortName: 'Haiku', description: 'Fast & efficient', provider: 'claude', contextWindow: 200000 },
];

export const CODEX_MODELS: ModelDefinition[] = [
  { id: 'codex-1', name: 'Codex 1', shortName: 'Codex', description: 'OpenAI Codex agent', provider: 'codex', contextWindow: 192000 },
  { id: 'gpt-4.1', name: 'GPT-4.1', shortName: 'GPT-4.1', description: 'General-purpose', provider: 'codex', contextWindow: 1048576 },
  { id: 'o3', name: 'o3', shortName: 'o3', description: 'Reasoning model', provider: 'codex', contextWindow: 200000 },
];

export const MODELS: ModelDefinition[] = [
  ...CLAUDE_MODELS,
  ...CODEX_MODELS,
];

// ============================================
// PURPOSE-SPECIFIC DEFAULTS
// ============================================

/** Default model for main chat (user-facing) */
export const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

/** Model for agent definition extraction (always high quality) */
export const EXTRACTION_MODEL = 'claude-opus-4-6';

/** Model for API response summarization (cost efficient) */
export const SUMMARIZATION_MODEL = 'claude-haiku-4-5-20251001';

/** Model for instruction updates (high quality for accurate document editing) */
export const INSTRUCTION_UPDATE_MODEL = 'claude-opus-4-6';


// ============================================
// HELPER FUNCTIONS
// ============================================

/** Get display name for a model ID (full name with version) */
export function getModelDisplayName(modelId: string): string {
  const model = MODELS.find(m => m.id === modelId);
  if (model) return model.name;
  // Fallback: strip prefix and date suffix
  return modelId.replace('claude-', '').replace(/-\d{8}$/, '');
}

/** Get short display name for a model ID (without version number) */
export function getModelShortName(modelId: string): string {
  const model = MODELS.find(m => m.id === modelId);
  if (model) return model.shortName;
  // For provider-prefixed IDs (e.g. "openai/gpt-5"), show just the model part
  if (modelId.includes('/')) {
    return modelId.split('/').pop() || modelId;
  }
  // Fallback: strip claude- prefix and date suffix, capitalize first letter
  const name = modelId.replace('claude-', '').replace(/-[\d.-]+$/, '');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Get known context window size for a model ID (fallback when SDK hasn't reported usage yet) */
export function getModelContextWindow(modelId: string): number | undefined {
  return MODELS.find(m => m.id === modelId)?.contextWindow;
}

/** Check if model is an Opus model (for cache TTL decisions) */
export function isOpusModel(modelId: string): boolean {
  return modelId.includes('opus');
}

/**
 * Check if a model ID refers to a Claude model.
 * Handles both direct Anthropic IDs (e.g. "claude-sonnet-4-5-20250929")
 * and provider-prefixed IDs (e.g. "anthropic/claude-sonnet-4" via OpenRouter).
 */
export function isClaudeModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return lower.startsWith('claude-') || lower.includes('/claude');
}

export function isCodexModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return lower.startsWith('codex-') || lower.startsWith('gpt-') || lower === 'o3' || lower.includes('/codex');
}

export function getModelsForProvider(provider: ProviderType): ModelDefinition[] {
  return MODELS.filter(m => m.provider === provider);
}

export function detectProviderFromModel(modelId: string): ProviderType {
  if (isCodexModel(modelId)) return 'codex';
  return 'claude';
}
