import { createSdkMcpServer, tool, AbortError, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { resetClaudeConfigCheck } from './options.ts';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { ForceStopError as ProviderForceStopError } from './providers/claude/claude-agent.ts';
import { detectInactiveSourceToolError, ToolIndex, buildWindowsSkillsDirError } from './providers/claude/event-normalizer.ts';
import type { AgentProvider, ChatExecutionConfig, MessageDelivery, ProviderType } from './providers/types.ts';
import { createProvider } from './providers/factory.ts';
import { z } from 'zod';
import { getSystemPrompt, getDateTimeContext, getWorkingDirectoryContext } from '../prompts/system.ts';
// Plan types are used by UI components; not needed in craft-agent.ts since Safe Mode is user-controlled
import { parseError, type AgentError } from './errors.ts';
import { runErrorDiagnostics } from './diagnostics.ts';
import { loadStoredConfig, loadConfigDefaults, getAnthropicBaseUrl, resolveModelId, type Workspace } from '../config/storage.ts';
import { isLocalMcpEnabled, generateSlug } from '../workspaces/storage.ts';
import { loadPlanFromPath, type SessionConfig as Session } from '../sessions/storage.ts';
import { DEFAULT_MODEL } from '../config/models.ts';
import { getCredentialManager } from '../credentials/index.ts';
import { updatePreferences, loadPreferences, formatPreferencesForPrompt, type UserPreferences } from '../config/preferences.ts';
import type { FileAttachment } from '../utils/files.ts';
import { debug } from '../utils/debug.ts';
import { ForceStopError } from './session-runner.ts';
import { HeartbeatManager, readHeartbeat, isHeartbeatActive } from '../sessions/heartbeat.ts';
import {
  getSessionPlansDir,
  getLastPlanFilePath,
  clearPlanFileState,
  registerSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
  getSessionScopedTools,
  cleanupSessionScopedTools,
  type AuthRequest,
} from './session-scoped-tools.ts';
import {
  getPermissionMode,
  setPermissionMode,
  cyclePermissionMode,
  initializeModeState,
  cleanupModeState,
  formatSessionState,
  shouldAllowToolInMode,
  blockWithReason,
  isApiEndpointAllowed,
  type PermissionMode,
  PERMISSION_MODE_CONFIG,
  SAFE_MODE_CONFIG,
} from './mode-manager.ts';
import { type PermissionsContext, permissionsConfigCache } from './permissions-config.ts';
import { getSessionPlansPath, getSessionPath } from '../sessions/storage.ts';
import { readFileSync } from 'fs';
import { expandPath } from '../utils/paths.ts';
import {
  ConfigWatcher,
  createConfigWatcher,
  type ConfigWatcherCallbacks,
} from '../config/watcher.ts';
import type { ValidationIssue } from '../config/validators.ts';
import { detectConfigFileType, detectAppConfigFileType, validateConfigFileContent, formatValidationResult } from '../config/validators.ts';
import { type ThinkingLevel, getThinkingTokens, DEFAULT_THINKING_LEVEL } from './thinking-levels.ts';
import type { LoadedSource } from '../sources/types.ts';
import { sourceNeedsAuthentication } from '../sources/credential-manager.ts';
import { loadCredentialRegistry } from '../credentials/registry.ts';

// Re-export permission mode functions for application usage
export {
  // Permission mode API
  getPermissionMode,
  setPermissionMode,
  cyclePermissionMode,
  subscribeModeChanges,
  type PermissionMode,
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_CONFIG,
} from './mode-manager.ts';
// Documentation is served via local files at ~/.craft-agent/docs/

// Import and re-export AgentEvent from core (single source of truth)
import type { AgentEvent } from '@craft-agent/core/types';
export type { AgentEvent };

// Stateless tool matching — pure functions for SDK message → AgentEvent conversion
import { extractToolStarts, extractToolResults, type ContentBlock } from './tool-matching.ts';

// Re-export types for UI components
export type { LoadedSource } from '../sources/types.ts';

/**
 * Reason for aborting agent execution.
 * Used to distinguish user-initiated stops from internal aborts.
 */
export enum AbortReason {
  /** User clicked stop button */
  UserStop = 'user_stop',
  /** Agent submitted a plan and is awaiting review */
  PlanSubmitted = 'plan_submitted',
  /** Agent requested authentication and is awaiting user input */
  AuthRequest = 'auth_request',
  /** New message sent while processing (silent redirect) */
  Redirect = 'redirect',
  /** Source was auto-activated mid-turn (silent, auto-retry follows) */
  SourceActivated = 'source_activated',
}

/**
 * Message type for recovery context building.
 * Simplified from StoredMessage - only what's needed for context injection.
 */
export interface RecoveryMessage {
  type: 'user' | 'assistant';
  content: string;
}

export interface CraftAgentConfig {
  workspace: Workspace;
  session?: Session;           // Current session (primary isolation boundary)
  mcpToken?: string;           // Override token (for testing)
  provider?: ProviderType;     // Provider to use (defaults to 'claude')
  model?: string;
  thinkingLevel?: ThinkingLevel; // Initial thinking level (defaults to 'think')
  onSdkSessionIdUpdate?: (sdkSessionId: string) => void;  // Callback when SDK session ID is captured
  onSdkSessionIdCleared?: () => void;  // Callback when SDK session ID is cleared (e.g., after failed resume)
  /**
   * Callback to get recent messages for recovery context.
   * Called when SDK resume fails and we need to inject previous conversation context into retry.
   * Returns last N user/assistant message pairs for context injection.
   */
  getRecoveryMessages?: () => RecoveryMessage[];
  isHeadless?: boolean;        // Running in headless mode (disables interactive tools)
  debugMode?: {                // Debug mode configuration (when running in dev)
    enabled: boolean;          // Whether debug mode is active
    logFilePath?: string;      // Path to the log file for querying
  };
  /** System prompt preset for mini agents ('default' | 'mini' or custom string) */
  systemPromptPreset?: 'default' | 'mini' | string;
}

// Permission request tracking
interface PendingPermission {
  resolve: (allowed: boolean, alwaysAllow?: boolean) => void;
  toolName: string;
  command: string;
  baseCommand: string;
  type?: 'bash' | 'safe_mode';  // Type of permission request
}

// Dangerous commands that should always require permission (never auto-allow)
const DANGEROUS_COMMANDS = new Set([
  'rm', 'rmdir', 'sudo', 'su', 'chmod', 'chown', 'chgrp',
  'mv', 'cp', 'dd', 'mkfs', 'fdisk', 'parted',
  'kill', 'killall', 'pkill',
  'reboot', 'shutdown', 'halt', 'poweroff',
  'curl', 'wget', 'ssh', 'scp', 'rsync',
  'git push', 'git reset', 'git rebase', 'git checkout',
]);

// ============================================================
// Global Tool Permission System
// Used by both bash commands (via agent instance) and MCP tools (via global functions)
// ============================================================

interface GlobalPendingPermission {
  resolve: (allowed: boolean) => void;
  toolName: string;
  command: string;
}

const globalPendingPermissions = new Map<string, GlobalPendingPermission>();

// Handler set by application to receive permission requests
let globalPermissionHandler: ((request: { requestId: string; toolName: string; command: string; description: string }) => void) | null = null;

/**
 * Set the global permission request handler (called by application)
 */
export function setGlobalPermissionHandler(
  handler: ((request: { requestId: string; toolName: string; command: string; description: string }) => void) | null
): void {
  globalPermissionHandler = handler;
}

/**
 * Request permission for a tool operation (used by MCP tools)
 * Returns a promise that resolves to true if allowed, false if denied
 */
export function requestToolPermission(
  toolName: string,
  command: string,
  description: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const requestId = `perm-${toolName}-${Date.now()}`;

    globalPendingPermissions.set(requestId, {
      resolve,
      toolName,
      command,
    });

    if (globalPermissionHandler) {
      globalPermissionHandler({ requestId, toolName, command, description });
    } else {
      // No handler - deny by default
      globalPendingPermissions.delete(requestId);
      resolve(false);
    }
  });
}

/**
 * Resolve a pending global permission request (called by application)
 */
export function resolveGlobalPermission(requestId: string, allowed: boolean): void {
  const pending = globalPendingPermissions.get(requestId);
  if (pending) {
    pending.resolve(allowed);
    globalPendingPermissions.delete(requestId);
  }
}

/**
 * Clear all pending global permissions (called on workspace switch)
 */
export function clearGlobalPermissions(): void {
  globalPendingPermissions.clear();
}

// Handle preferences update (extracted for use in MCP tool)
function handleUpdatePreferences(input: Record<string, unknown>): string {
  const updates: Partial<UserPreferences> = {};

  if (input.name && typeof input.name === 'string') {
    updates.name = input.name;
  }
  if (input.timezone && typeof input.timezone === 'string') {
    updates.timezone = input.timezone;
  }
  if (input.language && typeof input.language === 'string') {
    updates.language = input.language;
  }

  // Handle location fields
  if (input.city || input.region || input.country) {
    updates.location = {};
    if (input.city && typeof input.city === 'string') {
      updates.location.city = input.city;
    }
    if (input.region && typeof input.region === 'string') {
      updates.location.region = input.region;
    }
    if (input.country && typeof input.country === 'string') {
      updates.location.country = input.country;
    }
  }

  // Handle notes (append to existing)
  if (input.notes && typeof input.notes === 'string') {
    const current = loadPreferences();
    const existingNotes = current.notes || '';
    const newNote = input.notes;
    updates.notes = existingNotes
      ? `${existingNotes}\n- ${newNote}`
      : `- ${newNote}`;
  }

  // Check if anything was actually updated
  const fields = Object.keys(updates).filter(k => k !== 'location');
  if (updates.location) {
    fields.push(...Object.keys(updates.location).map(k => `location.${k}`));
  }

  if (fields.length === 0) {
    return 'No preferences were updated (no valid fields provided)';
  }

  updatePreferences(updates);
  return `Updated user preferences: ${fields.join(', ')}`;
}


// Base tool: update_user_preferences (always available)
const updateUserPreferencesTool = tool(
  'update_user_preferences',
  `Update stored user preferences. Use this when you learn information about the user that would be helpful to remember for future conversations. This includes their name, timezone, location, preferred language, or any other relevant notes. Only update fields you have confirmed information about - don't guess.`,
  {
    name: z.string().optional().describe("The user's preferred name or how they'd like to be addressed"),
    timezone: z.string().optional().describe("The user's timezone in IANA format (e.g., 'America/New_York', 'Europe/London')"),
    city: z.string().optional().describe("The user's city"),
    region: z.string().optional().describe("The user's state/region/province"),
    country: z.string().optional().describe("The user's country"),
    language: z.string().optional().describe("The user's preferred language for responses"),
    notes: z.string().optional().describe('Additional notes about the user that would be helpful to remember (preferences, context, etc.). This appends to existing notes.'),
  },
  async (args) => {
    try {
      const result = handleUpdatePreferences(args);
      return {
        content: [{ type: 'text', text: result }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Failed to update preferences: ${message}` }],
        isError: true,
      };
    }
  }
);

// Cached MCP server for preferences
let cachedPrefToolsServer: ReturnType<typeof createSdkMcpServer> | null = null;

// Preferences MCP server - user preferences tool
function getPreferencesServer(_unused?: boolean): ReturnType<typeof createSdkMcpServer> {
  if (!cachedPrefToolsServer) {
    cachedPrefToolsServer = createSdkMcpServer({
      name: 'preferences',
      version: '1.0.0',
      tools: [updateUserPreferencesTool],
    });
  }
  return cachedPrefToolsServer;
}

/**
 * SDK-compatible MCP server configuration.
 * Supports HTTP/SSE (remote) and stdio (local subprocess) transports.
 */
export type SdkMcpServerConfig =
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };

export class CraftAgent {
  private config: CraftAgentConfig;
  private provider: AgentProvider;
  private lastAbortReason: AbortReason | null = null;
  private sessionId: string | null = null;
  private isHeadless: boolean = false;
  private pendingPermissions: Map<string, PendingPermission> = new Map();
  private alwaysAllowedCommands: Set<string> = new Set(); // Base commands allowed for this session (e.g., "ls", "cat")
  private alwaysAllowedDomains: Set<string> = new Set(); // Domains allowed for curl/wget (session-scoped)
  // Pre-built source server configs (user-defined sources, separate from agent)
  // Supports both HTTP/SSE and stdio transports
  private sourceMcpServers: Record<string, SdkMcpServerConfig> = {};
  // In-process MCP servers for source API integrations
  private sourceApiServers: Record<string, ReturnType<typeof createSdkMcpServer>> = {};
  // Set of active source server names (for blocking disabled sources)
  private activeSourceServerNames: Set<string> = new Set();
  // Set of skill slugs invoked this session (for skill-level permissions)
  private activeSkillSlugs: Set<string> = new Set();
  // Set of intended active source slugs (what UI shows as active, may differ from activeSourceServerNames if build fails)
  private intendedActiveSlugs: Set<string> = new Set();
  // Full list of all sources in workspace (for context injection)
  private allSources: LoadedSource[] = [];
  // Sources already introduced to agent this session (for incremental context)
  private knownSourceSlugs: Set<string> = new Set();
  // Temporary clarifications (not yet saved to Craft document)
  private temporaryClarifications: string | null = null;
  // Safe mode state - user-controlled read-only exploration mode
  private safeMode: boolean = false;
  // Session-level thinking level ('off', 'think', 'max') - sticky, persisted
  private thinkingLevel: ThinkingLevel = 'think';
  // Ultrathink override - when true, boosts to max thinking for one message (resets after query)
  private ultrathinkOverride: boolean = false;
  // Config file watcher for hot-reloading source changes
  private configWatcher: ConfigWatcher | null = null;
  // Pinned system prompt components (captured on first chat, used for consistency after compaction)
  private pinnedPreferencesPrompt: string | null = null;
  // Track if preference drift notification has been shown this session
  private preferencesDriftNotified: boolean = false;
  // Pending resumeAt target for edit/reset conversation flow
  // When set, the next chat() call uses resumeSessionAt + forkSession
  private pendingResumeAt: string | null = null;

  // Heartbeat manager - tracks activity for multi-instance detection
  private heartbeatManager: HeartbeatManager | null = null;

  // Unique identifier for this app instance (for heartbeat comparison)
  private readonly instanceId = crypto.randomUUID();

  /**
   * Get the session ID for mode operations.
   * Returns a temp ID if no session is configured (shouldn't happen in practice).
   */
  private get modeSessionId(): string {
    return this.config.session?.id || `temp-${Date.now()}`;
  }

  /**
   * Get the workspace root path for workspace-scoped operations.
   */
  private get workspaceRootPath(): string {
    return this.config.workspace.rootPath;
  }

  /**
   * Get the session directory path for heartbeat and other session-scoped files.
   */
  private get sessionDir(): string | null {
    const sessionId = this.config.session?.id;
    if (!sessionId) return null;
    return getSessionPath(this.workspaceRootPath, sessionId);
  }

  // Callback for permission requests - set by application to receive permission prompts
  public onPermissionRequest: ((request: { requestId: string; toolName: string; command: string; description: string; type?: 'bash' }) => void) | null = null;

  // Debug callback for status messages
  public onDebug: ((message: string) => void) | null = null;

  /** Callback when permission mode changes */
  public onPermissionModeChange: ((mode: PermissionMode) => void) | null = null;

  // Callback when a plan is submitted - set by application to display plan message
  public onPlanSubmitted: ((planPath: string) => void) | null = null;

  // Callback when authentication is requested (unified auth flow)
  // This follows the SubmitPlan pattern:
  // 1. Tool calls onAuthRequest
  // 2. Session manager creates auth-request message and calls forceAbort
  // 3. User completes auth in UI
  // 4. Auth result is sent as a "faked user message"
  // 5. Agent resumes and processes the result
  public onAuthRequest: ((request: AuthRequest) => void) | null = null;

  // Callback when a source config changes (hot-reload from file watcher)
  public onSourceChange: ((slug: string, source: LoadedSource | null) => void) | null = null;

  // Callback when the sources list changes (add/remove)
  public onSourcesListChange: ((sources: LoadedSource[]) => void) | null = null;

  // Callback when config file validation fails
  public onConfigValidationError: ((file: string, errors: ValidationIssue[]) => void) | null = null;

  // Callback when a source tool is called but the source isn't enabled in the session.
  // The callback should enable the source and return true if successful, false otherwise.
  // This enables auto-enabling sources when the agent tries to use their tools.
  public onSourceActivationRequest: ((sourceSlug: string) => Promise<boolean>) | null = null;

  constructor(config: CraftAgentConfig) {
    // Resolve model: prioritize session model > config model > DEFAULT_MODEL
    const model = config.session?.model ?? config.model ?? DEFAULT_MODEL;
    this.config = { ...config, model };
    this.isHeadless = config.isHeadless ?? false;

    this.provider = createProvider(config.provider ?? "claude");

    // Log which model is being used (helpful for debugging custom models)
    debug(`[CraftAgent] Using model: ${model}`);

    // Initialize thinking level from config (defaults to 'think' from class initialization)
    if (config.thinkingLevel) {
      this.thinkingLevel = config.thinkingLevel;
    }

    // Initialize sessionId from session config for conversation resumption
    if (config.session?.sdkSessionId) {
      this.sessionId = config.session.sdkSessionId;
    }

    // Initialize permission mode state with callbacks
    const sessionId = this.modeSessionId;
    // Get initial mode: from session, or from global default
    const globalDefaults = loadConfigDefaults();
    const initialMode: PermissionMode = config.session?.permissionMode ?? globalDefaults.workspaceDefaults.permissionMode;

    initializeModeState(sessionId, initialMode, {
      onStateChange: (state) => {
        // Sync permission mode state with agent
        this.safeMode = state.permissionMode === 'safe';
        // Set env var for credential proxy Explore mode enforcement
        process.env.CRAFT_PERMISSION_MODE = state.permissionMode;
        // Notify UI of permission mode changes
        this.onPermissionModeChange?.(state.permissionMode);
      },
    });

    // Register session-scoped tool callbacks
    const toolCallbacks = {
      onPlanSubmitted: (planPath: string) => {
        this.onDebug?.(`[CraftAgent] onPlanSubmitted received: ${planPath}`);
        this.onPlanSubmitted?.(planPath);
      },
      onAuthRequest: (request: AuthRequest) => {
        this.onDebug?.(`[CraftAgent] onAuthRequest received: ${request.sourceSlug} (type: ${request.type})`);
        this.onAuthRequest?.(request);
      },
    };
    registerSessionScopedToolCallbacks(sessionId, toolCallbacks);

    // Wire callbacks to Codex provider's session bridge
    if (this.provider.type === "codex" && "setSessionToolCallbacks" in this.provider) {
      (this.provider as any).setSessionToolCallbacks(toolCallbacks);
    }

    // Set workspace root path env var for credential proxy and other tools
    process.env.CRAFT_WORKSPACE_ROOT = this.workspaceRootPath;

    // Start config watcher for hot-reloading source changes
    // Only start in non-headless mode to avoid overhead in batch/script scenarios
    if (!this.isHeadless) {
      this.startConfigWatcher();
    }
  }

  /**
   * Start the config file watcher for hot-reloading changes.
   */
  private startConfigWatcher(): void {
    if (this.configWatcher) {
      return; // Already running
    }

    this.configWatcher = createConfigWatcher(this.workspaceRootPath, {
      onSourceChange: (slug, source) => {
        debug('[CraftAgent] Source changed:', slug, source ? 'updated' : 'deleted');
        this.onSourceChange?.(slug, source);
      },
      onSourcesListChange: (sources) => {
        debug('[CraftAgent] Sources list changed:', sources.length);
        this.onSourcesListChange?.(sources);
      },
      onValidationError: (file, result) => {
        debug('[CraftAgent] Config validation error:', file, result.errors);
        this.onConfigValidationError?.(file, result.errors);
      },
      onError: (file, error) => {
        debug('[CraftAgent] Config file error:', file, error.message);
      },
    });

    debug('[CraftAgent] Config watcher started');
  }

  /**
   * Stop the config file watcher.
   */
  private stopConfigWatcher(): void {
    if (this.configWatcher) {
      this.configWatcher.stop();
      this.configWatcher = null;
      debug('[CraftAgent] Config watcher stopped');
    }
  }

  // ============================================================
  // Persistent Session Lifecycle
  // ============================================================

  /**
   * Stop the persistent session runner.
   * Called on session switch, workspace change, history clear, or dispose.
   */

  /**
   * Initialize heartbeat manager for this session.
   */
  private initHeartbeatManager(): void {
    if (!this.sessionDir) return;

    if (!this.heartbeatManager) {
      this.heartbeatManager = new HeartbeatManager(this.sessionDir, this.instanceId);
      debug('[CraftAgent] Initialized heartbeat manager');
    }
  }

  /**
   * Stop and cleanup heartbeat manager.
   */
  private stopHeartbeatManager(): void {
    if (this.heartbeatManager) {
      this.heartbeatManager.stop();
      this.heartbeatManager = null;
      debug('[CraftAgent] Stopped heartbeat manager');
    }
  }

  /**
   * Prepare the agent to resume from a specific point in the conversation.
   * The next chat() call will use resumeSessionAt + forkSession to branch
   * the SDK transcript from the given assistant message UUID.
   */
  prepareResetToMessage(sdkUuid: string): void {
    this.provider.forceStop();
    this.stopHeartbeatManager();

    // Store the target UUID — buildSessionOptions() will pick it up
    this.pendingResumeAt = sdkUuid;

    // Clear pinned state for fresh start
    this.pinnedPreferencesPrompt = null;
    this.preferencesDriftNotified = false;
  }

  /**
   * Check if another instance is actively using this session.
   * Returns a warning message if so, null otherwise.
   */
  private checkForSessionConflict(): string | null {
    if (!this.sessionDir) return null;

    const heartbeat = readHeartbeat(this.sessionDir);
    if (isHeartbeatActive(heartbeat, this.instanceId)) {
      const activity = heartbeat!.isStreaming
        ? 'processing a response'
        : `running ${heartbeat!.activeBackgroundTasks} background task(s)`;
      return `This session is actively being used in another window (${activity}). Background tasks may conflict.`;
    }

    return null;
  }

  /**
   * Build the hooks configuration for SDK options.
   * Contains all PreToolUse logic including permission handling, path expansion,
   * config validation, skill qualification, and metadata stripping.
   */
  private buildHooks(sessionId: string): Options['hooks'] {
    // Helper to request permission and wait for response
    const requestPermission = async (
      toolUseId: string,
      toolName: string,
      command: string,
      baseCommand: string,
      description: string
    ): Promise<{ allowed: boolean }> => {
      const requestId = `perm-${toolUseId}`;
      debug(`[PreToolUse] Requesting permission for ${toolName}: ${command}`);

      const permissionPromise = new Promise<boolean>((resolve) => {
        this.pendingPermissions.set(requestId, {
          resolve,
          toolName,
          command,
          baseCommand,
        });
      });

      if (this.onPermissionRequest) {
        this.onPermissionRequest({
          requestId,
          toolName,
          command,
          description,
        });
      } else {
        this.pendingPermissions.delete(requestId);
        return { allowed: false };
      }

      const allowed = await permissionPromise;
      return { allowed };
    };

    return {
      PreToolUse: [{
        hooks: [async (input) => {
          if (input.hook_event_name !== 'PreToolUse') {
            return { continue: true };
          }

          const permissionMode = getPermissionMode(sessionId);
          this.onDebug?.(`PreToolUse hook: ${input.tool_name} (permissionMode=${permissionMode})`);

          // Build permissions context for loading custom permissions.json files
          const permissionsContext: PermissionsContext = {
            workspaceRootPath: this.workspaceRootPath,
            activeSourceSlugs: Array.from(this.activeSourceServerNames),
            activeSkillSlugs: Array.from(this.activeSkillSlugs),
          };

          const plansFolderPath = sessionId ? getSessionPlansPath(this.workspaceRootPath, sessionId) : undefined;

          // ============================================================
          // PERMISSION MODE HANDLING
          // - 'safe': Block writes entirely (read-only mode)
          // - 'ask': Prompt for dangerous operations
          // - 'allow-all': Everything allowed, no prompts
          // ============================================================

          // In 'allow-all' mode, still check for explicitly blocked tools
          if (permissionMode === 'allow-all') {
            const result = shouldAllowToolInMode(
              input.tool_name,
              input.tool_input,
              'allow-all',
              { plansFolderPath, permissionsContext }
            );

            if (!result.allowed) {
              this.onDebug?.(`Allow-all mode: blocking explicitly blocked tool ${input.tool_name}`);
              return blockWithReason(result.reason);
            }

            this.onDebug?.(`Allow-all mode: allowing ${input.tool_name}`);
          }

          // In 'ask' mode, still check for explicitly blocked tools
          if (permissionMode === 'ask') {
            const result = shouldAllowToolInMode(
              input.tool_name,
              input.tool_input,
              'ask',
              { plansFolderPath, permissionsContext }
            );

            if (!result.allowed) {
              this.onDebug?.(`Ask mode: blocking explicitly blocked tool ${input.tool_name}`);
              return blockWithReason(result.reason);
            }
          }

          // In 'safe' mode, check against read-only allowlist
          if (permissionMode === 'safe') {
            const result = shouldAllowToolInMode(
              input.tool_name,
              input.tool_input,
              'safe',
              { plansFolderPath, permissionsContext }
            );

            if (!result.allowed) {
              this.onDebug?.(`Safe mode: blocking ${input.tool_name}`);
              return blockWithReason(result.reason);
            }

            this.onDebug?.(`Allowed in safe mode: ${input.tool_name}`);
          }

          // ============================================================
          // SOURCE BLOCKING & AUTO-ENABLE: Handle tools from sources
          // ============================================================
          if (input.tool_name.startsWith('mcp__')) {
            const parts = input.tool_name.split('__');
            const serverName = parts[1];
            if (parts.length >= 3 && serverName) {
              const builtInMcpServers = new Set(['preferences', 'session', 'craft-agents-docs']);

              if (!builtInMcpServers.has(serverName)) {
                const isActive = this.activeSourceServerNames.has(serverName);
                if (!isActive) {
                  const sourceExists = this.allSources.some(s => s.config.slug === serverName);

                  if (sourceExists && this.onSourceActivationRequest) {
                    this.onDebug?.(`Source "${serverName}" not active, attempting auto-enable...`);
                    try {
                      const activated = await this.onSourceActivationRequest(serverName);
                      if (activated) {
                        this.onDebug?.(`Source "${serverName}" auto-enabled successfully, tools available next turn`);
                        return {
                          continue: false,
                          decision: 'block' as const,
                          reason: `STOP. Source "${serverName}" has been activated successfully. The tools will be available on the next turn. Do NOT try other tool names or approaches. Respond to the user now: tell them the source is now active and ask them to send their request again.`,
                        };
                      } else {
                        this.onDebug?.(`Source "${serverName}" auto-enable failed (may need authentication)`);
                        return {
                          continue: false,
                          decision: 'block' as const,
                          reason: `Source "${serverName}" could not be activated. It may require authentication. Please check the source status and authenticate if needed.`,
                        };
                      }
                    } catch (error) {
                      this.onDebug?.(`Source "${serverName}" auto-enable error: ${error}`);
                      return {
                        continue: false,
                        decision: 'block' as const,
                        reason: `Failed to activate source "${serverName}": ${error instanceof Error ? error.message : 'Unknown error'}`,
                      };
                    }
                  } else if (sourceExists) {
                    this.onDebug?.(`BLOCKED source tool: ${input.tool_name} (source "${serverName}" exists but is not enabled)`);
                    return {
                      continue: false,
                      decision: 'block' as const,
                      reason: `Source "${serverName}" is available but not enabled for this session. Please enable it in the sources panel.`,
                    };
                  } else {
                    this.onDebug?.(`BLOCKED source tool: ${input.tool_name} (source "${serverName}" does not exist)`);
                    return {
                      continue: false,
                      decision: 'block' as const,
                      reason: `Source "${serverName}" could not be connected. It may need re-authentication, or the server may be unreachable. Check the source in the sidebar for details.`,
                    };
                  }
                }
              }
            }
          }

          // ============================================================
          // PATH EXPANSION: Expand ~ in file paths for SDK file tools
          // ============================================================
          const filePathTools = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit']);
          if (filePathTools.has(input.tool_name)) {
            const toolInput = input.tool_input as Record<string, unknown>;
            let updatedInput: Record<string, unknown> | null = null;

            // Expand file_path if present and starts with ~
            if (typeof toolInput.file_path === 'string' && toolInput.file_path.startsWith('~')) {
              const expandedPath = expandPath(toolInput.file_path);
              this.onDebug?.(`Expanding path: ${toolInput.file_path} → ${expandedPath}`);
              updatedInput = { ...toolInput, file_path: expandedPath };
            }

            // Expand notebook_path if present and starts with ~
            if (typeof toolInput.notebook_path === 'string' && toolInput.notebook_path.startsWith('~')) {
              const expandedPath = expandPath(toolInput.notebook_path);
              this.onDebug?.(`Expanding notebook path: ${toolInput.notebook_path} → ${expandedPath}`);
              updatedInput = { ...(updatedInput || toolInput), notebook_path: expandedPath };
            }

            // Expand path if present and starts with ~ (for Glob, Grep)
            if (typeof toolInput.path === 'string' && toolInput.path.startsWith('~')) {
              const expandedPath = expandPath(toolInput.path);
              this.onDebug?.(`Expanding search path: ${toolInput.path} → ${expandedPath}`);
              updatedInput = { ...(updatedInput || toolInput), path: expandedPath };
            }

            // ============================================================
            // CONFIG FILE VALIDATION: Validate before allowing write
            // ============================================================
            const configWriteTools = new Set(['Write', 'Edit']);
            if (configWriteTools.has(input.tool_name)) {
              const resolvedPath = (updatedInput?.file_path ?? toolInput.file_path) as string | undefined;

              if (resolvedPath) {
                const detection = detectConfigFileType(resolvedPath, this.workspaceRootPath)
                  ?? detectAppConfigFileType(resolvedPath);

                if (detection) {
                  let contentToValidate: string | null = null;

                  if (input.tool_name === 'Write') {
                    contentToValidate = toolInput.content as string;
                  } else if (input.tool_name === 'Edit') {
                    try {
                      const currentContent = readFileSync(resolvedPath, 'utf-8');
                      const oldString = toolInput.old_string as string;
                      const newString = toolInput.new_string as string;
                      const replaceAll = toolInput.replace_all as boolean | undefined;
                      contentToValidate = replaceAll
                        ? currentContent.replaceAll(oldString, newString)
                        : currentContent.replace(oldString, newString);
                    } catch {
                      // File doesn't exist yet or can't be read — skip validation
                    }
                  }

                  if (contentToValidate) {
                    const validationResult = validateConfigFileContent(detection, contentToValidate);
                    if (validationResult && !validationResult.valid) {
                      this.onDebug?.(`Config validation blocked ${input.tool_name} to ${detection.displayFile}: ${validationResult.errors.length} errors`);
                      return {
                        continue: false,
                        decision: 'block' as const,
                        reason: `Cannot write invalid config to ${detection.displayFile}.\n\n${formatValidationResult(validationResult)}\n\nFix the errors above and try again.`,
                      };
                    }
                  }
                }
              }
            }

            // If any path was expanded, return updated input
            if (updatedInput) {
              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  updatedInput,
                },
              };
            }
          }

          // ============================================================
          // SKILL QUALIFICATION: Ensure skill names are fully-qualified
          // Also track invoked skills for skill-level permissions
          // ============================================================
          if (input.tool_name === 'Skill') {
            const toolInput = input.tool_input as { skill?: string; args?: string };
            if (toolInput.skill) {
              // Extract slug from qualified name (e.g., "my-workspace:xero" → "xero")
              const skillSlug = toolInput.skill.includes(':')
                ? toolInput.skill.split(':').pop()!
                : toolInput.skill;
              this.activeSkillSlugs.add(skillSlug);
              this.onDebug?.(`Skill invoked, permissions activated: ${skillSlug}`);

              if (!toolInput.skill.includes(':')) {
                const pluginName = generateSlug(this.config.workspace.name);
                const qualifiedSkill = `${pluginName}:${toolInput.skill}`;
                this.onDebug?.(`Skill tool: qualified "${toolInput.skill}" → "${qualifiedSkill}"`);
                return {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse' as const,
                    updatedInput: { ...toolInput, skill: qualifiedSkill },
                  },
                };
              }
            }
          }

          // ============================================================
          // STRIP METADATA: Remove _intent/_displayName from MCP tools
          // ============================================================
          const builtInTools = new Set([
            'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
            'WebFetch', 'WebSearch', 'Task', 'TaskOutput',
            'TodoWrite', 'MultiEdit', 'NotebookEdit', 'KillShell',
            'SubmitPlan', 'Skill', 'SlashCommand',
          ]);

          if (!builtInTools.has(input.tool_name)) {
            const toolInput = input.tool_input as Record<string, unknown>;
            const hasMetadata = '_intent' in toolInput || '_displayName' in toolInput;

            if (hasMetadata) {
              const { _intent, _displayName, ...cleanInput } = toolInput;
              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  updatedInput: cleanInput,
                },
              };
            }
          }

          // ============================================================
          // ASK MODE PERMISSION PROMPTS
          // ============================================================

          // For file write operations in 'ask' mode, prompt for permission
          const fileWriteTools = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
          if (fileWriteTools.has(input.tool_name) && permissionMode === 'ask') {
            const toolInput = input.tool_input as Record<string, unknown>;
            const filePath = (toolInput.file_path as string) || (toolInput.notebook_path as string) || 'unknown';

            if (this.alwaysAllowedCommands.has(input.tool_name)) {
              this.onDebug?.(`Auto-allowing "${input.tool_name}" (previously approved)`);
              return { continue: true };
            }

            const result = await requestPermission(
              input.tool_use_id,
              input.tool_name,
              filePath,
              input.tool_name,
              `${input.tool_name}: ${filePath}`
            );

            if (!result.allowed) {
              return {
                continue: false,
                decision: 'block' as const,
                reason: 'User denied permission',
              };
            }
          }

          // For MCP mutation tools in 'ask' mode, prompt for permission
          if (input.tool_name.startsWith('mcp__') && permissionMode === 'ask') {
            const safeModeResult = shouldAllowToolInMode(
              input.tool_name,
              input.tool_input,
              'safe',
              { plansFolderPath }
            );

            if (!safeModeResult.allowed) {
              const serverAndTool = input.tool_name.replace('mcp__', '').replace(/__/g, '/');

              if (this.alwaysAllowedCommands.has(input.tool_name)) {
                this.onDebug?.(`Auto-allowing "${input.tool_name}" (previously approved)`);
                return { continue: true };
              }

              const result = await requestPermission(
                input.tool_use_id,
                'MCP Tool',
                serverAndTool,
                input.tool_name,
                `MCP: ${serverAndTool}`
              );

              if (!result.allowed) {
                return {
                  continue: false,
                  decision: 'block' as const,
                  reason: 'User denied permission',
                };
              }
            }
          }

          // For API mutation calls in 'ask' mode, prompt for permission
          if (input.tool_name.startsWith('api_') && permissionMode === 'ask') {
            const toolInput = input.tool_input as Record<string, unknown>;
            const method = ((toolInput?.method as string) || 'GET').toUpperCase();
            const path = toolInput?.path as string | undefined;

            if (method !== 'GET') {
              const apiDescription = `${method} ${path || ''}`;

              if (isApiEndpointAllowed(method, path, permissionsContext)) {
                this.onDebug?.(`Auto-allowing API "${apiDescription}" (whitelisted in permissions.json)`);
                return { continue: true };
              }

              if (this.alwaysAllowedCommands.has(apiDescription)) {
                this.onDebug?.(`Auto-allowing API "${apiDescription}" (previously approved)`);
                return { continue: true };
              }

              const result = await requestPermission(
                input.tool_use_id,
                'API Call',
                apiDescription,
                apiDescription,
                `API: ${apiDescription}`
              );

              if (!result.allowed) {
                return {
                  continue: false,
                  decision: 'block' as const,
                  reason: 'User denied permission',
                };
              }
            }
          }

          // For Bash in 'ask' mode, check if we need permission
          if (input.tool_name === 'Bash' && permissionMode === 'ask') {
            const command = typeof input.tool_input === 'object' && input.tool_input !== null
              ? (input.tool_input as Record<string, unknown>).command
              : JSON.stringify(input.tool_input);
            const commandStr = String(command);
            const baseCommand = this.getBaseCommand(commandStr);

            const mergedConfig = permissionsConfigCache.getMergedConfig(permissionsContext);
            const isReadOnly = mergedConfig.readOnlyBashPatterns.some(pattern => pattern.regex.test(commandStr.trim()));
            if (isReadOnly) {
              this.onDebug?.(`Auto-allowing read-only command: ${baseCommand}`);
              return { continue: true };
            }

            if (this.alwaysAllowedCommands.has(baseCommand) && !this.isDangerousCommand(baseCommand)) {
              this.onDebug?.(`Auto-allowing "${baseCommand}" (previously approved)`);
              return { continue: true };
            }

            if (['curl', 'wget'].includes(baseCommand)) {
              const domain = this.extractDomainFromNetworkCommand(commandStr);
              if (domain && this.alwaysAllowedDomains.has(domain)) {
                this.onDebug?.(`Auto-allowing ${baseCommand} to "${domain}" (domain whitelisted)`);
                return { continue: true };
              }
            }

            const requestId = `perm-${input.tool_use_id}`;
            debug(`[PreToolUse] Requesting permission for Bash command: ${commandStr}`);

            const permissionPromise = new Promise<boolean>((resolve) => {
              this.pendingPermissions.set(requestId, {
                resolve,
                toolName: input.tool_name,
                command: commandStr,
                baseCommand,
              });
            });

            if (this.onPermissionRequest) {
              this.onPermissionRequest({
                requestId,
                toolName: input.tool_name,
                command: commandStr,
                description: `Execute: ${commandStr}`,
              });
            } else {
              this.pendingPermissions.delete(requestId);
              return {
                continue: false,
                decision: 'block' as const,
                reason: 'No permission handler available',
              };
            }

            const allowed = await permissionPromise;
            if (!allowed) {
              return {
                continue: false,
                decision: 'block' as const,
                reason: 'User denied permission',
              };
            }
          }

          return { continue: true };
        }],
      }],
      SubagentStart: [{
        hooks: [async (input, _hookToolUseID) => {
          const typedInput = input as { agent_id?: string; agent_type?: string };
          debug(`[CraftAgent] SubagentStart: agent_id=${typedInput.agent_id}, type=${typedInput.agent_type}`);
          return { continue: true };
        }],
      }],
      SubagentStop: [{
        hooks: [async (input, _toolUseID) => {
          const typedInput = input as { agent_id?: string };
          debug(`[CraftAgent] SubagentStop: agent_id=${typedInput.agent_id}`);
          return { continue: true };
        }],
      }],
    };
  }


  /**
   * Handle a source config update from the file watcher.
   * Updates internal MCP/API server state when a source changes.
   */
  private handleSourceUpdate(slug: string, source: LoadedSource | null): void {
    if (!source) {
      // Source was deleted - remove from active servers
      delete this.sourceMcpServers[slug];
      delete this.sourceApiServers[slug];
      this.activeSourceServerNames.delete(slug);
      debug('[CraftAgent] Removed source:', slug);
      return;
    }

    // Source was updated - check if we need to update server state
    if (!source.config.enabled) {
      // Disabled - remove from active servers
      delete this.sourceMcpServers[slug];
      delete this.sourceApiServers[slug];
      this.activeSourceServerNames.delete(slug);
      debug('[CraftAgent] Disabled source:', slug);
    } else {
      // Enabled - add to active servers (will be rebuilt on next query)
      this.activeSourceServerNames.add(slug);
      debug('[CraftAgent] Enabled source:', slug);
      // Note: Actual MCP/API server configs are rebuilt in getOptions()
      // This just marks the source as active for the next run
    }
  }

  /**
   * Set the session-level thinking level.
   * This is sticky and persisted across messages.
   */
  setThinkingLevel(level: ThinkingLevel): void {
    this.thinkingLevel = level;
    this.onDebug?.(`[CraftAgent] Thinking level: ${level}`);
  }

  /**
   * Get the current session-level thinking level.
   */
  getThinkingLevel(): ThinkingLevel {
    return this.thinkingLevel;
  }

  /**
   * Enable or disable ultrathink override (per-message boost to max thinking).
   * When enabled, overrides thinkingLevel to 'max' for one message only.
   * Resets to false after query completes.
   */
  setUltrathinkOverride(enabled: boolean): void {
    this.ultrathinkOverride = enabled;
    this.onDebug?.(`[CraftAgent] Ultrathink override: ${enabled ? 'ENABLED' : 'disabled'}`);
  }

  /**
   * Extract the base command from a bash command string
   * e.g., "ls -la /tmp" -> "ls", "git push origin main" -> "git push"
   */
  private getBaseCommand(command: string): string {
    const trimmed = command.trim();

    // Handle git subcommands specially (git push, git reset, etc.)
    if (trimmed.startsWith('git ')) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        return `${parts[0]} ${parts[1]}`;
      }
    }

    // For other commands, just take the first word
    const firstWord = trimmed.split(/\s+/)[0] || trimmed;
    return firstWord;
  }

  /**
   * Check if a command is dangerous (should never be auto-allowed)
   */
  private isDangerousCommand(baseCommand: string): boolean {
    return DANGEROUS_COMMANDS.has(baseCommand);
  }

  /**
   * Extract domain from a curl/wget command
   * e.g., curl https://api.example.com/path -> "api.example.com"
   */
  private extractDomainFromNetworkCommand(command: string): string | null {
    const urlMatch = command.match(/https?:\/\/([^\/\s"']+)/i);
    return urlMatch?.[1] ?? null;
  }

  /**
   * Respond to a pending permission request
   */
  respondToPermission(requestId: string, allowed: boolean, alwaysAllow: boolean = false): void {
    this.onDebug?.(`respondToPermission: ${requestId}, allowed=${allowed}, alwaysAllow=${alwaysAllow}, pending=${this.pendingPermissions.has(requestId)}`);
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      this.onDebug?.(`Resolving permission promise for ${requestId}`);

      // If "always allow" was selected, remember it (with special handling for curl/wget)
      if (alwaysAllow && allowed) {
        if (['curl', 'wget'].includes(pending.baseCommand)) {
          // For curl/wget, whitelist the domain instead of the command
          const domain = this.extractDomainFromNetworkCommand(pending.command);
          if (domain) {
            this.alwaysAllowedDomains.add(domain);
            this.onDebug?.(`Added domain "${domain}" to always-allowed domains`);
          }
        } else if (!this.isDangerousCommand(pending.baseCommand)) {
          this.alwaysAllowedCommands.add(pending.baseCommand);
          this.onDebug?.(`Added "${pending.baseCommand}" to always-allowed commands`);
        }
      }

      pending.resolve(allowed);
      this.pendingPermissions.delete(requestId);
    } else {
      this.onDebug?.(`No pending permission found for ${requestId}`);
    }
  }

  // ============================================
  // Safe Mode Methods
  // ============================================

  /**
   * Check if currently in safe mode (read-only exploration)
   * Uses modeManager as single source of truth.
   */
  isInSafeMode(): boolean {
    return getPermissionMode(this.modeSessionId) === 'safe';
  }

  /**
   * Check if a task should trigger planning (heuristic)
   * Returns true for complex tasks that would benefit from planning
   */
  shouldSuggestPlanning(userMessage: string): boolean {
    const message = userMessage.toLowerCase();

    // Keywords that suggest complex tasks
    const complexKeywords = [
      'implement', 'create', 'build', 'develop', 'design',
      'refactor', 'migrate', 'upgrade', 'restructure',
      'add feature', 'new feature', 'integrate',
      'set up', 'setup', 'configure', 'install',
      'multiple', 'several', 'all', 'entire', 'whole',
    ];

    // Check for complex keywords
    const hasComplexKeyword = complexKeywords.some(keyword => message.includes(keyword));

    // Check message length (longer messages often indicate complex tasks)
    const isLongMessage = message.length > 200;

    // Check for multiple sentences (indicates multi-step task)
    const sentenceCount = message.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
    const hasMultipleSentences = sentenceCount > 2;

    return hasComplexKeyword || isLongMessage || hasMultipleSentences;
  }

  /**
   * Check if a tool requires permission and handle it
   * Returns true if allowed, false if denied
   */
  private async checkToolPermission(
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string
  ): Promise<{ allowed: boolean; updatedInput: Record<string, unknown> }> {
    // Bash commands require permission
    if (toolName === 'Bash') {
      const command = typeof input.command === 'string' ? input.command : JSON.stringify(input);
      const baseCommand = command.trim().split(/\s+/)[0] || command;
      const requestId = `perm-${toolUseId}`;

      // Create a promise that will be resolved when user responds
      const permissionPromise = new Promise<boolean>((resolve) => {
        this.pendingPermissions.set(requestId, {
          resolve,
          toolName,
          command,
          baseCommand,
        });
      });

      // Notify application of permission request via callback (not event yield)
      if (this.onPermissionRequest) {
        this.onPermissionRequest({
          requestId,
          toolName,
          command,
          description: `Execute bash command: ${command}`,
        });
      } else {
        // No permission handler - deny by default for safety
        this.pendingPermissions.delete(requestId);
        return { allowed: false, updatedInput: input };
      }

      // Wait for user response
      const allowed = await permissionPromise;
      return { allowed, updatedInput: input };
    }

    // All other tools are auto-approved
    return { allowed: true, updatedInput: input };
  }

  private async getToken(): Promise<string | null> {
    // Only return token if explicitly provided via config
    // Sources handle their own authentication
    return this.config.mcpToken ?? null;
  }

  async *chat(
    userMessage: string,
    attachments?: FileAttachment[],
    _isRetry: boolean = false // Internal flag for session expiry retry
  ): AsyncGenerator<AgentEvent> {
    try {
      const sessionId = this.config.session?.id || `temp-${Date.now()}`;

      // ============================================================
      // Multi-Instance Conflict Detection
      // Check if another instance is actively using this session
      // ============================================================
      const conflictWarning = this.checkForSessionConflict();
      if (conflictWarning) {
        yield { type: 'info', message: conflictWarning };
      }

      // Initialize heartbeat manager for this session
      this.initHeartbeatManager();

      // Mark streaming as started (activates heartbeat)
      if (this.heartbeatManager) {
        this.heartbeatManager.setStreaming(true);
      }

      // Pin system prompt components on first chat() call for consistency after compaction
      // The SDK's resume mechanism expects system prompt consistency within a session
      const currentPreferencesPrompt = formatPreferencesForPrompt();

      if (this.pinnedPreferencesPrompt === null) {
        // First chat in this session - pin current values
        this.pinnedPreferencesPrompt = currentPreferencesPrompt;
        debug('[chat] Pinned system prompt components for session consistency');
      } else {
        // Detect drift: warn user if context has changed since session started
        const preferencesDrifted = currentPreferencesPrompt !== this.pinnedPreferencesPrompt;

        if (preferencesDrifted && !this.preferencesDriftNotified) {
          yield {
            type: 'info',
            message: `Note: Your preferences changed since this session started. Start a new session to apply changes.`,
          };
          this.preferencesDriftNotified = true;
          debug(`[chat] Detected drift in: preferences`);
        }
      }

      // Check if we have binary attachments that need the AsyncIterable interface
      const hasBinaryAttachments = attachments?.some(a => a.type === 'image' || a.type === 'pdf');

      // Validate we have something to send
      if (!userMessage.trim() && (!attachments || attachments.length === 0)) {
        yield { type: 'error', message: 'Cannot send empty message' };
        yield { type: 'complete' };
        return;
      }

      // Resolve model and thinking configuration
      const isMiniAgent = this.config.systemPromptPreset === 'mini';
      const modelConfig = this.config.model || DEFAULT_MODEL;
      const model = resolveModelId(modelConfig);
      const effectiveThinkingLevel: ThinkingLevel = this.thinkingLevel;
      const thinkingTokens = getThinkingTokens(effectiveThinkingLevel, modelConfig);

      // Disallowed tools (SDK features we don't support)
      const disallowedTools: string[] = ['EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion'];

      // Build MCP servers configuration
      const sourceMcpResult = this.getSourceMcpServersFiltered();
      const mcpServers = isMiniAgent
        ? {
            session: getSessionScopedTools(sessionId, this.workspaceRootPath),
            'craft-agents-docs': {
              type: 'http',
              url: 'https://agents.craft.do/docs/mcp',
            },
          }
        : {
            preferences: getPreferencesServer(false),
            session: getSessionScopedTools(sessionId, this.workspaceRootPath),
            'craft-agents-docs': {
              type: 'http',
              url: 'https://agents.craft.do/docs/mcp',
            },
            ...sourceMcpResult.servers,
            ...this.sourceApiServers,
          };

      if (isMiniAgent) {
        debug("[CraftAgent] Mini agent mode - optimized for quick config edits");
      }

      // Build system prompt (pinned preferences for consistency after compaction)
      const systemPrompt = this.config.systemPromptPreset === "mini"
        ? getSystemPrompt(undefined, undefined, this.workspaceRootPath, undefined, "mini")
        : {
            type: "preset" as const,
            preset: "claude_code" as const,
            append: getSystemPrompt(
              this.pinnedPreferencesPrompt ?? undefined,
              this.config.debugMode,
              this.workspaceRootPath,
              this.config.session?.workingDirectory
            ),
          };

      const sdkCwd = this.config.session?.sdkCwd ??
        (sessionId ? getSessionPath(this.workspaceRootPath, sessionId) : this.workspaceRootPath);

      // Build message delivery format
      const SDK_SLASH_COMMANDS = ["compact"] as const;
      const trimmedMessage = userMessage.trim();
      const commandMatch = trimmedMessage.match(/^\/([a-z]+)(\s|$)/i);
      const commandName = commandMatch?.[1]?.toLowerCase();
      const isSlashCommand = commandName &&
        SDK_SLASH_COMMANDS.includes(commandName as typeof SDK_SLASH_COMMANDS[number]) &&
        !attachments?.length;

      let delivery: MessageDelivery;
      if (isSlashCommand) {
        debug(`[chat] Detected SDK slash command: ${trimmedMessage}`);
        delivery = { mode: "slash_command", text: trimmedMessage };
      } else if (hasBinaryAttachments) {
        const sdkMessage = this.buildSDKUserMessage(userMessage, attachments);
        delivery = { mode: "sdk_message", sdkMessage };
      } else {
        const prompt = this.buildTextPrompt(userMessage, attachments);
        delivery = { mode: "text", text: prompt };
      }

      // Sync provider session state before building config
      this.provider.setSessionId(this.sessionId);

      const executionConfig: ChatExecutionConfig = {
        delivery,
        model,
        modelConfig,
        isMiniAgent,
        thinkingLevel: effectiveThinkingLevel,
        ultrathink: this.ultrathinkOverride,
        permissionMode: getPermissionMode(sessionId),
        mcpServers,
        systemPrompt,
        sessionId,
        sdkCwd,
        resumeSessionId: this.sessionId,
        pendingResumeAt: this.pendingResumeAt,
        isRetry: _isRetry,
        hooks: this.buildHooks(sessionId),
        workspaceRootPath: this.workspaceRootPath,
        disallowedTools,
        onSessionIdUpdate: (id) => {
          this.sessionId = id;
          this.config.onSdkSessionIdUpdate?.(id);
        },
        onDebug: (msg) => this.onDebug?.(msg),
      };

      // Track whether we're trying to resume a session (for error handling)
      const wasResuming = !_isRetry && !!this.sessionId;

      if (wasResuming) {
        debug(`[CraftAgent] Attempting to resume SDK session: ${this.sessionId}`);
      } else {
        debug("[CraftAgent] Starting fresh SDK session (no resume)");
      }

      // Clear pendingResumeAt — provider will consume it
      if (this.pendingResumeAt) {
        this.pendingResumeAt = null;
      }

      let receivedComplete = false;
      let receivedAssistantContent = false;
      const toolIndex = new ToolIndex();

      try {
        for await (const event of this.provider.executeChat(executionConfig)) {
          // Sync session ID back from provider
          const providerSessionId = this.provider.getSessionId();
          if (providerSessionId && providerSessionId !== this.sessionId) {
            this.sessionId = providerSessionId;
          }

          if (event.type === "text_delta" || event.type === "text_complete" || event.type === "tool_start") {
            receivedAssistantContent = true;
          }

          // Check for tool-not-found errors on inactive sources and attempt auto-activation
          const inactiveSourceError = detectInactiveSourceToolError(
            event,
            toolIndex,
            this.allSources,
            this.activeSourceServerNames
          );

          if (inactiveSourceError && this.onSourceActivationRequest) {
            const { sourceSlug } = inactiveSourceError;

            this.onDebug?.(`Detected tool call to inactive source "${sourceSlug}", attempting activation...`);

            try {
              const activated = await this.onSourceActivationRequest(sourceSlug);

              if (activated) {
                this.onDebug?.(`Source "${sourceSlug}" activated successfully, interrupting turn for auto-retry`);

                yield {
                  type: "source_activated" as const,
                  sourceSlug,
                  originalMessage: userMessage,
                };

                this.forceAbort(AbortReason.SourceActivated);
                return;
              } else {
                this.onDebug?.(`Source "${sourceSlug}" activation failed (may need auth)`);
                const toolResultEvent = event as Extract<AgentEvent, { type: "tool_result" }>;
                yield {
                  type: "tool_result" as const,
                  toolUseId: toolResultEvent.toolUseId,
                  toolName: toolResultEvent.toolName,
                  result: `Source "${sourceSlug}" could not be activated. It may require authentication. Please check the source status in the sources panel.`,
                  isError: true,
                  input: toolResultEvent.input,
                  turnId: toolResultEvent.turnId,
                  parentToolUseId: toolResultEvent.parentToolUseId,
                };
                continue;
              }
            } catch (error) {
              this.onDebug?.(`Source "${sourceSlug}" activation error: ${error}`);
            }
          }

          if (event.type === "complete") {
            receivedComplete = true;
          }

          yield event;
        }

        // Detect empty response when resuming - SDK silently fails resume if session is invalid
        // In this case, we got a new session ID but no assistant content
        debug('[SESSION_DEBUG] Post-loop check: wasResuming=', wasResuming, 'receivedAssistantContent=', receivedAssistantContent, '_isRetry=', _isRetry);
        if (wasResuming && !receivedAssistantContent && !_isRetry) {
          debug('[SESSION_DEBUG] >>> DETECTED EMPTY RESPONSE - triggering recovery');
          // SDK resume failed silently - clear session and retry with context
          this.sessionId = null;
          // Notify that we're clearing the session ID (for persistence)
          this.config.onSdkSessionIdCleared?.();
          // Clear pinned state for fresh start
          this.pinnedPreferencesPrompt = null;
          this.preferencesDriftNotified = false;

          // Build recovery context from previous messages to inject into retry
          const recoveryContext = this.buildRecoveryContext();
          const messageWithContext = recoveryContext
            ? recoveryContext + userMessage
            : userMessage;

          yield { type: 'info', message: 'Restoring conversation context...' };
          // Retry with fresh session, injecting conversation history into the message
          yield* this.chat(messageWithContext, attachments, true);
          return;
        }

        // Defensive: emit complete if SDK didn't send result message
        if (!receivedComplete) {
          yield { type: 'complete' };
        }
      } catch (sdkError) {

        // Debug: log inner catch trigger (stderr to avoid SDK JSON pollution)
        console.error(`[CraftAgent] INNER CATCH triggered: ${sdkError instanceof Error ? sdkError.message : String(sdkError)}`);

        // Handle force-stop (plan submission, auth request, user abort via forceStop).
        // ForceStopError is thrown by SessionRunner when forceStop() nullifies the
        // iterator mid-iteration. Treat it identically to AbortError.
        if (sdkError instanceof ForceStopError) {
          const reason = this.lastAbortReason;
          this.lastAbortReason = null;

          // Stream health auto-recovery: if the watchdog triggered forceStop (not a
          // user/plan/redirect abort), clean up the dead session and auto-retry.
          // The _isRetry guard prevents infinite loops.
          if (this.provider.getStreamHealthTriggered?.() && !_isRetry) {
            debug('[StreamHealth] Auto-recovery: clearing dead session and retrying');
            // Clean up dead session state
            this.sessionId = null;
            this.config.onSdkSessionIdCleared?.();
            this.pinnedPreferencesPrompt = null;
            this.preferencesDriftNotified = false;

            // Build context prefix so the LLM knows it was interrupted
            const recoveryContext = this.buildRecoveryContext();
            const contextPrefix = '> **Note:** Your previous response was interrupted by a connection issue. Continue where you left off.\n\n';
            const messageWithContext = contextPrefix + (recoveryContext ? recoveryContext + userMessage : userMessage);

            yield { type: 'info', message: 'Connection recovered — continuing...' };
            yield* this.chat(messageWithContext, attachments, true);
            return;
          }

          if (reason === AbortReason.UserStop) {
            yield { type: 'status', message: 'Interrupted' };
          }
          yield { type: 'complete' };
          return;
        }

        // Handle user interruption
        if (sdkError instanceof AbortError) {
          const reason = this.lastAbortReason;
          this.lastAbortReason = null;  // Clear for next time

          // If interrupted before receiving any assistant content AND this was the first message,
          // clear session ID to prevent broken resume state where SDK session file is empty/invalid.
          // For later messages (messageCount > 0), keep the session ID to preserve conversation history.
          // The SDK session file should have valid previous turns we can resume from.
          if (!receivedAssistantContent && this.sessionId) {
            // Check if there are previous messages (completed turns) in this session
            // If yes, keep the session ID to preserve history on resume
            const hasCompletedTurns = this.config.getRecoveryMessages && this.config.getRecoveryMessages().length > 0;

            if (!hasCompletedTurns) {
              // First message was interrupted before any response - SDK session is empty/corrupt
              debug('[SESSION_DEBUG] First message interrupted before assistant content - clearing sdkSessionId:', this.sessionId);
              this.sessionId = null;
              this.config.onSdkSessionIdCleared?.();
            } else {
              // Later message interrupted - SDK session has valid history, keep it for resume
              debug('[SESSION_DEBUG] Later message interrupted - keeping sdkSessionId for history preservation:', this.sessionId);
            }
          }

          // Only emit "Interrupted" status for user-initiated stops
          // Plan submissions and redirects should be silent
          if (reason === AbortReason.UserStop) {
            yield { type: 'status', message: 'Interrupted' };
          }
          yield { type: 'complete' };
          return;
        }

        // Get error message regardless of error type
        // Note: SDK text errors like "API Error: 402..." are primarily handled in useAgent.ts
        // via text_complete event. This is a fallback for errors that don't emit text first.
        // parseError() will detect status codes (402, 401, etc.) in the raw message.
        const rawErrorMsg = sdkError instanceof Error ? sdkError.message : String(sdkError);
        const errorMsg = rawErrorMsg.toLowerCase();

        // Debug logging - always log the actual error and context
        this.onDebug?.(`Error in chat: ${rawErrorMsg}`);
        this.onDebug?.(`Context: wasResuming=${wasResuming}, isRetry=${_isRetry}`);

        // Check for auth errors - these won't be fixed by clearing session
        const isAuthError =
          errorMsg.includes('unauthorized') ||
          errorMsg.includes('401') ||
          errorMsg.includes('authentication failed') ||
          errorMsg.includes('invalid api key') ||
          errorMsg.includes('invalid x-api-key');

        if (isAuthError) {
          // Auth errors surface immediately - session manager handles retry by recreating agent
          const typedError = parseError(new Error(rawErrorMsg));
          yield { type: 'typed_error', error: typedError };
          yield { type: 'complete' };
          return;
        }

        // Rate limit errors - don't retry immediately, surface to user
        const isRateLimitError =
          errorMsg.includes('429') ||
          errorMsg.includes('rate limit') ||
          errorMsg.includes('too many requests');

        if (isRateLimitError) {
          // Parse to typed error using the captured/processed error message
          const typedError = parseError(new Error(rawErrorMsg));
          yield { type: 'typed_error', error: typedError };
          yield { type: 'complete' };
          return;
        }

        // Check for billing/payment errors (402) - don't retry these
        const isBillingError =
          errorMsg.includes('402') ||
          errorMsg.includes('payment required') ||
          errorMsg.includes('billing');

        if (isBillingError) {
          // Parse to typed error using the captured/processed error message, not the original SDK error
          // This ensures parseError sees "402 Payment required" instead of "process exited with code 1"
          const typedError = parseError(new Error(rawErrorMsg));
          yield { type: 'typed_error', error: typedError };
          yield { type: 'complete' };
          return;
        }

        // Check for .claude.json corruption — the SDK subprocess crashes if this file
        // is empty, BOM-encoded, or contains invalid JSON. Two error patterns:
        //   1. "CLI output was not valid JSON" — CLI wrote plain-text error to stdout
        //   2. "process exited with code 1" with stderr mentioning config corruption
        // See: claude-code#14442 (BOM), #2593 (empty file), #18998 (race condition)
        const stderrForConfigCheck = (this.provider.getLastStderrOutput?.() ?? []).join('\n').toLowerCase();
        const isConfigCorruption =
          (errorMsg.includes('not valid json') && (errorMsg.includes('claude') || errorMsg.includes('configuration'))) ||
          (errorMsg.includes('process exited with code') && (
            stderrForConfigCheck.includes('claude.json') ||
            stderrForConfigCheck.includes('configuration file') ||
            stderrForConfigCheck.includes('corrupted')
          ));

        if (isConfigCorruption && !_isRetry) {
          debug('[CraftAgent] Detected .claude.json corruption, repairing and retrying...');
          // Reset the once-per-process guard so ensureClaudeConfig() runs again
          // on the retry — it will repair the file before the next subprocess spawn
          resetClaudeConfigCheck();
          yield { type: 'info', message: 'Repairing configuration file...' };
          yield* this.chat(userMessage, attachments, true);
          return;
        }

        // Check for SDK process errors - these often wrap underlying billing/auth issues
        // The SDK's internal Claude Code process exits with code 1 for various API errors
        const isProcessError = errorMsg.includes('process exited with code');

        // [SESSION_DEBUG] Comprehensive logging for session recovery investigation
        debug('[SESSION_DEBUG] === ERROR HANDLER ENTRY ===');
        debug('[SESSION_DEBUG] errorMsg:', errorMsg);
        debug('[SESSION_DEBUG] rawErrorMsg:', rawErrorMsg);
        debug('[SESSION_DEBUG] isProcessError:', isProcessError);
        debug('[SESSION_DEBUG] wasResuming:', wasResuming);
        debug('[SESSION_DEBUG] _isRetry:', _isRetry);
        debug('[SESSION_DEBUG] this.sessionId:', this.sessionId);
        debug('[SESSION_DEBUG] lastStderrOutput length:', (this.provider.getLastStderrOutput?.() ?? []).length);
        debug('[SESSION_DEBUG] lastStderrOutput:', (this.provider.getLastStderrOutput?.() ?? []).join('\n'));

        if (isProcessError) {
          // Include captured stderr in diagnostics - this is often where the real error is
          const lastStderr = this.provider.getLastStderrOutput?.() ?? [];
          const stderrContext = lastStderr.length > 0
            ? lastStderr.join('\n')
            : undefined;
          if (stderrContext) {
            debug('[SDK process error] Captured stderr:', stderrContext);
          }

          // Check for expired session error - SDK session no longer exists server-side
          // This happens when sessions expire (TTL) or are cleaned up by Anthropic
          const isSessionExpired = stderrContext?.includes('No conversation found with session ID');
          debug('[SESSION_DEBUG] isSessionExpired:', isSessionExpired);

          if (isSessionExpired && wasResuming && !_isRetry) {
            debug('[SESSION_DEBUG] >>> TAKING PATH: Session expired recovery');
            console.error('[CraftAgent] SDK session expired server-side, clearing and retrying fresh');
            debug('[CraftAgent] SDK session expired server-side, clearing and retrying fresh');
            this.sessionId = null;
            // Clear pinned state so retry captures fresh values
            this.pinnedPreferencesPrompt = null;
            this.preferencesDriftNotified = false;
            // Use 'info' instead of 'status' to show message without spinner
            yield { type: 'info', message: 'Session expired, restoring context...' };
            // Recursively call with isRetry=true (yield* delegates all events)
            yield* this.chat(userMessage, attachments, true);
            return;
          }

          // Check for Windows SDK setup error (missing .claude/skills directory)
          const windowsSkillsError = buildWindowsSkillsDirError(stderrContext || rawErrorMsg);
          if (windowsSkillsError) {
            yield windowsSkillsError;
            yield { type: 'complete' };
            return;
          }

          debug('[SESSION_DEBUG] >>> TAKING PATH: Run diagnostics (not session expired)');

          // Run diagnostics to identify specific cause (2s timeout)
          const storedConfig = loadStoredConfig();
          const diagnostics = await runErrorDiagnostics({
            authType: storedConfig?.authType,
            workspaceId: this.config.workspace?.id,
            rawError: stderrContext || rawErrorMsg,
          });

          debug('[SESSION_DEBUG] diagnostics.code:', diagnostics.code);
          debug('[SESSION_DEBUG] diagnostics.title:', diagnostics.title);
          debug('[SESSION_DEBUG] diagnostics.message:', diagnostics.message);

          // Get recovery actions based on diagnostic code
          const actions = diagnostics.code === 'token_expired' || diagnostics.code === 'mcp_unreachable'
            ? [
                { key: 'w', label: 'Open workspace menu', command: '/workspace' },
                { key: 'r', label: 'Retry', action: 'retry' as const },
              ]
            : diagnostics.code === 'invalid_credentials' || diagnostics.code === 'billing_error'
            ? [
                { key: 's', label: 'Update credentials', command: '/settings', action: 'settings' as const },
              ]
            : [
                { key: 'r', label: 'Retry', action: 'retry' as const },
                { key: 's', label: 'Check settings', command: '/settings', action: 'settings' as const },
              ];

          yield {
            type: 'typed_error',
            error: {
              code: diagnostics.code,
              title: diagnostics.title,
              message: diagnostics.message,
              // Include stderr in details if we captured any useful output
              details: stderrContext
                ? [...(diagnostics.details || []), `SDK stderr: ${stderrContext}`]
                : diagnostics.details,
              actions,
              canRetry: diagnostics.code !== 'billing_error' && diagnostics.code !== 'invalid_credentials',
              retryDelayMs: 1000,
              originalError: stderrContext || rawErrorMsg,
            },
          };
          yield { type: 'complete' };
          return;
        }

        // Session-related retry: only if we were resuming and haven't retried yet
        debug('[SESSION_DEBUG] isProcessError=false, checking wasResuming fallback');
        if (wasResuming && !_isRetry) {
          debug('[SESSION_DEBUG] >>> TAKING PATH: wasResuming fallback retry');
          this.sessionId = null;
          // Clear pinned state so retry captures fresh values
          this.pinnedPreferencesPrompt = null;
          this.preferencesDriftNotified = false;

          // Provide context-aware message (conservative: only match explicit session/resume terms)
          const isSessionError =
            errorMsg.includes('session') ||
            errorMsg.includes('resume');

          debug('[SESSION_DEBUG] isSessionError (for message):', isSessionError);

          const statusMessage = isSessionError
            ? 'Conversation sync failed, starting fresh...'
            : 'Request failed, retrying without history...';

          // Use 'info' instead of 'status' to show message without spinner
          yield { type: 'info', message: statusMessage };
          // Recursively call with isRetry=true (yield* delegates all events)
          yield* this.chat(userMessage, attachments, true);
          return;
        }

        debug('[SESSION_DEBUG] >>> TAKING PATH: Final fallback (show generic error)');
        // Retry also failed, or wasn't resuming - show generic error
        // (Auth, billing, and rate limit errors are handled above)
        const rawMessage = sdkError instanceof Error ? sdkError.message : String(sdkError);

        yield { type: 'error', message: rawMessage };
        yield { type: 'complete' };
        return;
      }

    } catch (error) {
      // Debug: log outer catch trigger (stderr to avoid SDK JSON pollution)
      console.error(`[CraftAgent] OUTER CATCH triggered: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`[CraftAgent] Error stack: ${error instanceof Error ? error.stack : 'no stack'}`);

      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if this is a recognizable error type
      const typedError = parseError(error);
      if (typedError.code !== 'unknown_error') {
        // Known error type - show user-friendly message with recovery actions
        yield { type: 'typed_error', error: typedError };
      } else {
        // Unknown error - show raw message
        yield { type: 'error', message: errorMessage };
      }
      // emit complete even on error so application knows we're done
      yield { type: 'complete' };
    } finally {
      // Reset ultrathink override after query completes (single-shot per-message boost)
      // Note: thinkingLevel is NOT reset - it's sticky for the session
      this.ultrathinkOverride = false;

      // Mark streaming as complete (deactivates heartbeat if no background tasks)
      if (this.heartbeatManager) {
        this.heartbeatManager.setStreaming(false);
      }
    }
  }

  /**
   * Format source state as a lightweight XML block for injection into user messages.
   * Shows active sources, inactive sources, and introduces new sources with taglines.
   * New sources (not seen before this session) include descriptions to help agent understand usage.
   *
   * Active sources are determined by intendedActiveSlugs (what UI shows as active).
   * If a source is intended-active but has no working tools (build failed), we note the issue.
   */
  private formatSourceState(): string {
    // Use intended active slugs (what UI shows) rather than just what built successfully
    const activeSlugs = [...this.intendedActiveSlugs].sort();

    // Find inactive sources (in allSources but not intended-active)
    const inactiveSources = this.allSources.filter(
      (s) => !this.intendedActiveSlugs.has(s.config.slug)
    );

    // Find sources not yet seen this session
    const unseenSources = this.allSources.filter(
      (s) => !this.knownSourceSlugs.has(s.config.slug)
    );

    // Find active sources that need attention (needs_auth or failed status)
    const activeSources = this.allSources.filter(
      (s) => this.intendedActiveSlugs.has(s.config.slug)
    );
    const sourcesNeedingAttention = activeSources.filter(
      (s) => s.config.connectionStatus === 'needs_auth' || s.config.connectionStatus === 'failed'
    );

    // Check if this is the first message (no sources known yet)
    const isFirstMessage = this.knownSourceSlugs.size === 0;

    // Mark all current sources as known for next message
    this.allSources.forEach((s) => this.knownSourceSlugs.add(s.config.slug));

    // Build output parts
    const parts: string[] = [];

    // Active sources line - include warning for sources with failed builds
    if (activeSlugs.length > 0) {
      const activeWithStatus = activeSlugs.map((slug) => {
        const hasWorkingTools = this.activeSourceServerNames.has(slug);
        return hasWorkingTools ? slug : `${slug} (no tools)`;
      });
      parts.push(`Active: ${activeWithStatus.join(', ')}`);
    } else {
      parts.push('Active: none');
    }

    // Inactive sources with reason
    // Use sourceNeedsAuthentication() to correctly check if auth is required,
    // not just whether isAuthenticated is set. Sources with authType: "none"
    // should show "inactive" not "needs auth".
    if (inactiveSources.length > 0) {
      const inactiveList = inactiveSources.map((s) => {
        const reason = !s.config.enabled
          ? 'disabled'
          : sourceNeedsAuthentication(s)
            ? 'needs auth'
            : 'inactive';
        return `${s.config.slug} (${reason})`;
      });
      parts.push(`Inactive: ${inactiveList.join(', ')}`);
    }

    // Source descriptions (shown once per session when first introduced)
    if (unseenSources.length > 0) {
      parts.push('');
      // Only show "New:" header for mid-conversation additions, not first message
      if (!isFirstMessage) {
        parts.push('New:');
      }
      for (const s of unseenSources) {
        const tagline = s.config.tagline || s.config.provider;
        parts.push(`- ${s.config.slug}: ${tagline}`);
      }
    }

    let output = `<sources>\n${parts.join('\n')}\n</sources>`;

    // Inject issue context for sources needing attention (auth failed, etc.)
    // These are ALWAYS shown, regardless of "seen" status, to ensure agent can troubleshoot
    for (const s of sourcesNeedingAttention) {
      const status = s.config.connectionStatus;
      output += `\n\n<source_issue source="${s.config.slug}" status="${status}">`;

      if (s.config.connectionError) {
        output += `\nError: ${s.config.connectionError}`;
      }

      // Provide context-aware fix instructions based on auth type and transport
      const authTool = this.getAuthToolName(s);
      if (authTool) {
        // Auth-based source - likely revoked or expired token
        output += `\n\nThis source requires re-authentication. The user may have revoked access or the token expired.`;
        output += `\nTo fix: Re-authenticate using ${authTool}.`;
      } else if (s.config.mcp?.transport === 'stdio') {
        // Local stdio server - process may have crashed or isn't installed
        output += `\n\nThis is a local MCP server that is not responding. The server process may need to be restarted.`;
        output += `\nTo fix: Check if the server command/path is correct and the process can start.`;
      } else {
        // Remote no-auth source - server unreachable or URL changed
        output += `\n\nThis source's server is unreachable. It may be down or the URL may have changed.`;
        output += `\nTo fix: Check the server URL and network connectivity. Use WebSearch to verify the endpoint is correct.`;
      }
      output += `\n</source_issue>`;
    }

    return output;
  }

  /**
   * Format credential registry state for injection into user messages.
   * Shows registered credentials and their auth status so the agent
   * knows what APIs have auto-auth via the credential proxy.
   */
  private formatCredentialState(): string {
    const registry = loadCredentialRegistry(this.workspaceRootPath);
    if (registry.length === 0) return '';

    const lines: string[] = [];
    for (const cred of registry) {
      const status = cred.isAuthenticated ? '✓' : '○';
      const patterns = cred.urlPatterns.join(', ');
      lines.push(`- ${status} ${cred.name} (${cred.slug}): ${patterns} [${cred.auth.type}]`);
    }

    return `\n<credentials>\nRegistered credentials (auto-injected into matching HTTP requests):\n${lines.join('\n')}\n</credentials>`;
  }

  /**
   * Get the correct authentication tool name for a source, or null if no auth is needed.
   * Tool names are based on source type and provider, not the source slug.
   */
  private getAuthToolName(source: LoadedSource): string | null {
    const { type, provider, mcp, api } = source.config;

    // MCP sources
    if (type === 'mcp') {
      if (mcp?.authType === 'oauth') {
        return 'source_oauth_trigger';
      }
      if (mcp?.authType === 'bearer') {
        return 'source_credential_prompt';
      }
      // authType: 'none' or undefined (stdio) - no auth needed
      return null;
    }

    // API sources: check provider for specific OAuth triggers
    if (type === 'api') {
      // Check for no-auth APIs first
      if (api?.authType === 'none' || api?.authType === undefined) {
        return null;
      }

      // OAuth providers have specific triggers
      switch (provider) {
        case 'google':
          return 'source_google_oauth_trigger';
        case 'slack':
          return 'source_slack_oauth_trigger';
        case 'microsoft':
          return 'source_microsoft_oauth_trigger';
        default:
          // Non-OAuth API sources (api key, bearer, header, query) use credential prompt
          return 'source_credential_prompt';
      }
    }

    // Local sources or unknown - no auth
    return null;
  }

  /**
   * Format workspace capabilities for prompt injection.
   * Informs the agent about what features are available in this workspace.
   */
  private formatWorkspaceCapabilities(): string {
    const capabilities: string[] = [];

    // Check local MCP server capability
    const localMcpEnabled = isLocalMcpEnabled(this.workspaceRootPath);
    if (localMcpEnabled) {
      capabilities.push('local-mcp: enabled (stdio subprocess servers supported)');
    } else {
      capabilities.push('local-mcp: disabled (only HTTP/SSE servers)');
    }

    return `<workspace_capabilities>\n${capabilities.join('\n')}\n</workspace_capabilities>`;
  }

  /**
   * Build recovery context from previous messages when SDK resume fails.
   * Called when we detect an empty response during resume - we need to inject
   * the previous conversation context so the agent can continue naturally.
   *
   * Returns a formatted string to prepend to the user message, or null if no context available.
   */
  private buildRecoveryContext(): string | null {
    const messages = this.config.getRecoveryMessages?.();
    if (!messages || messages.length === 0) {
      return null;
    }

    // Format messages as a conversation block the agent can understand
    const formattedMessages = messages.map(m => {
      const role = m.type === 'user' ? 'User' : 'Assistant';
      // Truncate very long messages to avoid bloating context (max ~1000 chars each)
      const content = m.content.length > 1000
        ? m.content.slice(0, 1000) + '...[truncated]'
        : m.content;
      return `[${role}]: ${content}`;
    }).join('\n\n');

    return `<conversation_recovery>
This session was interrupted and is being restored. Here is the recent conversation context:

${formattedMessages}

Please continue the conversation naturally from where we left off.
</conversation_recovery>

`;
  }

  /**
   * Build a simple text prompt with embedded text file contents (for text-only messages)
   * Prepends date/time context for prompt caching optimization (keeps system prompt static)
   * Injects session state (including mode state) for every message
   */
  private buildTextPrompt(text: string, attachments?: FileAttachment[]): string {
    const parts: string[] = [];

    // Add date/time context first (moved from system prompt to enable caching)
    parts.push(getDateTimeContext());

    // Add session state (always includes all modes with true/false state)
    // This lightweight format replaces the verbose mode context
    // Include plans folder path so agent knows where to write plans in safe mode
    const plansFolderPath = getSessionPlansPath(this.workspaceRootPath, this.modeSessionId);
    parts.push(formatSessionState(this.modeSessionId, { plansFolderPath }));

    // Add source state (always included to inform agent about available sources)
    parts.push(this.formatSourceState());

    // Add credential registry state (if any credentials are registered)
    const credentialState = this.formatCredentialState();
    if (credentialState) {
      parts.push(credentialState);
    }

    // Add workspace capabilities (local MCP enabled/disabled, etc.)
    parts.push(this.formatWorkspaceCapabilities());

    // Add working directory context
    // Calculate effective working directory (same logic as cwd parameter)
    const effectiveWorkingDir = this.config.session?.workingDirectory ??
      (this.modeSessionId ? getSessionPath(this.workspaceRootPath, this.modeSessionId) : undefined);
    const isSessionRoot = !this.config.session?.workingDirectory && !!this.modeSessionId;
    // Pass sdkCwd so agent knows if bash runs from a different directory than workingDirectory
    const workingDirContext = getWorkingDirectoryContext(effectiveWorkingDir, isSessionRoot, this.config.session?.sdkCwd);
    if (workingDirContext) {
      parts.push(workingDirContext);
    }

    // Add file attachments with stored path info (agent uses Read tool to access content)
    // Text files are NOT embedded inline to prevent context overflow from large files
    if (attachments) {
      for (const attachment of attachments) {
        if (attachment.storedPath) {
          let pathInfo = `[Attached file: ${attachment.name}]`;
          pathInfo += `\n[Stored at: ${attachment.storedPath}]`;
          if (attachment.markdownPath) {
            pathInfo += `\n[Markdown version: ${attachment.markdownPath}]`;
          }
          parts.push(pathInfo);
        }
      }
    }

    // Add user's message
    if (text) {
      parts.push(text);
    }

    return parts.join('\n\n');
  }

  /**
   * Build an SDK user message with proper content blocks for binary attachments
   * Prepends date/time context for prompt caching optimization (keeps system prompt static)
   * Injects session state (including mode state) for every message
   */
  private buildSDKUserMessage(text: string, attachments?: FileAttachment[]): SDKUserMessage {
    const contentBlocks: ContentBlockParam[] = [];

    // Add date/time context first (moved from system prompt to enable caching)
    contentBlocks.push({ type: 'text', text: getDateTimeContext() });

    // Add session state (always includes all modes with true/false state)
    // This lightweight format replaces the verbose mode context
    // Include plans folder path so agent knows where to write plans in safe mode
    const plansFolderPath = getSessionPlansPath(this.workspaceRootPath, this.modeSessionId);
    contentBlocks.push({ type: 'text', text: formatSessionState(this.modeSessionId, { plansFolderPath }) });

    // Add source state (always included to inform agent about available sources)
    contentBlocks.push({ type: 'text', text: this.formatSourceState() });

    // Add credential registry state (if any credentials are registered)
    const credStateSdk = this.formatCredentialState();
    if (credStateSdk) {
      contentBlocks.push({ type: 'text', text: credStateSdk });
    }

    // Add workspace capabilities (local MCP enabled/disabled, etc.)
    contentBlocks.push({ type: 'text', text: this.formatWorkspaceCapabilities() });

    // Add working directory context
    // Calculate effective working directory (same logic as cwd parameter)
    const effectiveWorkingDirSdk = this.config.session?.workingDirectory ??
      (this.modeSessionId ? getSessionPath(this.workspaceRootPath, this.modeSessionId) : undefined);
    const isSessionRootSdk = !this.config.session?.workingDirectory && !!this.modeSessionId;
    // Pass sdkCwd so agent knows if bash runs from a different directory than workingDirectory
    const workingDirContextSdk = getWorkingDirectoryContext(effectiveWorkingDirSdk, isSessionRootSdk, this.config.session?.sdkCwd);
    if (workingDirContextSdk) {
      contentBlocks.push({ type: 'text', text: workingDirContextSdk });
    }

    // Add attachments - images/PDFs are uploaded inline, text files are path-only
    // Text files are NOT embedded to prevent context overflow; agent uses Read tool
    if (attachments) {
      for (const attachment of attachments) {
        // Add path info text block so the agent knows where the file is stored
        // This enables the agent to use the Read tool to access text/office files
        if (attachment.storedPath) {
          let pathInfo = `[Attached file: ${attachment.name}]\n[Stored at: ${attachment.storedPath}]`;
          if (attachment.markdownPath) {
            pathInfo += `\n[Markdown version: ${attachment.markdownPath}]`;
          }
          contentBlocks.push({
            type: 'text',
            text: pathInfo,
          });
        }

        // Only images and PDFs are uploaded inline (agent cannot read these with Read tool)
        if (attachment.type === 'image' && attachment.base64) {
          const mediaType = this.mapImageMediaType(attachment.mimeType);
          if (mediaType) {
            contentBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: attachment.base64,
              },
            });
          }
        } else if (attachment.type === 'pdf' && attachment.base64) {
          contentBlocks.push({
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: attachment.base64,
            },
          });
        }
        // Text files: path info already added above, agent uses Read tool to access content
      }
    }

    // Add user's text message
    if (text.trim()) {
      contentBlocks.push({ type: 'text', text });
    }

    return {
      type: 'user',
      message: {
        role: 'user',
        content: contentBlocks,
      },
      parent_tool_use_id: null,
      // Use current session ID if resuming, otherwise a temp ID
      // SDK streaming mode requires a session_id on each message
      session_id: this.sessionId || `temp-${Date.now()}`,
    } as SDKUserMessage;
  }

  /**
   * Map file MIME types to SDK-supported image types
   */
  private mapImageMediaType(mimeType?: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
    if (!mimeType) return null;
    const supported: Record<string, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'> = {
      'image/jpeg': 'image/jpeg',
      'image/png': 'image/png',
      'image/gif': 'image/gif',
      'image/webp': 'image/webp',
    };
    return supported[mimeType] || null;
  }

  clearHistory(): void {
    this.provider.forceStop();
    this.stopHeartbeatManager();

    this.sessionId = null;
    this.pinnedPreferencesPrompt = null;
    this.preferencesDriftNotified = false;
  }

  /**
   * Force-abort the current query using the SDK's AbortController.
   * This immediately stops processing (SIGTERM/SIGKILL) without waiting for graceful shutdown.
   * Use this when you need instant termination (e.g., queuing a new message).
   *
   * @param reason - Why the abort is happening (affects UI feedback)
   */
  forceAbort(reason: AbortReason = AbortReason.UserStop): void {
    this.lastAbortReason = reason;
    this.provider.forceStop();
  }

  getModel(): string {
    return this.config.model || DEFAULT_MODEL;
  }

  /**
   * Get the list of SDK tools (captured from init message)
   */
  getSdkTools(): string[] {
    return this.provider.getSdkTools();
  }

  setModel(model: string): void {
    this.config.model = model;
    // Note: Model change takes effect on the next query
  }

  getWorkspace(): Workspace {
    return this.config.workspace;
  }

  setWorkspace(workspace: Workspace): void {
    this.provider.forceStop();
    this.stopHeartbeatManager();

    this.config.workspace = workspace;
    // Clear session when switching workspaces - caller should set session separately if needed
    this.sessionId = null;
    // Note: MCP proxy needs to be reinitialized by the caller (useAgent hook)
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  /**
   * Update the working directory for this agent's session.
   * Called when user changes the working directory in the UI.
   */
  updateWorkingDirectory(path: string): void {
    if (this.config.session) {
      this.config.session.workingDirectory = path;
    }
  }

  /**
   * Set source servers (user-defined sources)
   * These are MCP servers and API tools added via the source selector UI
   * @param mcpServers Pre-built MCP server configs with auth headers
   * @param apiServers In-process MCP servers for REST APIs
   * @param intendedSlugs Optional list of source slugs that should be considered active
   *                      (what the UI shows as active, even if build failed)
   */
  setSourceServers(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, ReturnType<typeof createSdkMcpServer>>,
    intendedSlugs?: string[]
  ): void {
    this.sourceMcpServers = mcpServers;
    this.sourceApiServers = apiServers;

    // Update the set of active source server names for tool blocking
    this.activeSourceServerNames = new Set([
      ...Object.keys(mcpServers),
      ...Object.keys(apiServers),
    ]);

    // Update intended active slugs (defaults to what actually built if not specified)
    this.intendedActiveSlugs = new Set(intendedSlugs ?? [...this.activeSourceServerNames]);

    this.onDebug?.(`Active source servers: ${[...this.activeSourceServerNames].join(', ') || 'none'}`);
    if (intendedSlugs && intendedSlugs.length !== this.activeSourceServerNames.size) {
      const failed = intendedSlugs.filter(s => !this.activeSourceServerNames.has(s));
      if (failed.length > 0) {
        this.onDebug?.(`Sources with failed builds: ${failed.join(', ')}`);
      }
    }
  }

  /**
   * Check if a source server is currently active (enabled and authenticated)
   * Used by PreToolUse hook to block tools from disabled sources
   */
  isSourceServerActive(serverName: string): boolean {
    return this.activeSourceServerNames.has(serverName);
  }

  /**
   * Get the set of active source server names
   * Used to inform the agent about available sources
   */
  getActiveSourceServerNames(): Set<string> {
    return this.activeSourceServerNames;
  }

  /**
   * Set all sources in the workspace (for context injection)
   * Called by Electron to provide full source list including disabled sources
   */
  setAllSources(sources: LoadedSource[]): void {
    this.allSources = sources;
  }

  /**
   * Get all sources in the workspace
   */
  getAllSources(): LoadedSource[] {
    return this.allSources;
  }

  /**
   * Mark a source as unseen so its guide will be re-injected on next message.
   * Call this after re-authentication or when source state changes significantly.
   */
  markSourceUnseen(slug: string): void {
    this.knownSourceSlugs.delete(slug);
  }

  /**
   * Set temporary clarifications that are injected into the system prompt
   * but not yet persisted to the Craft document
   */
  setTemporaryClarifications(text: string | null): void {
    this.temporaryClarifications = text;
  }

  /**
   * Get filtered source MCP servers based on local MCP setting
   * @returns Object with filtered servers and names of any skipped stdio servers
   */
  private getSourceMcpServersFiltered(): { servers: Record<string, SdkMcpServerConfig>; skipped: string[] } {
    return this.filterMcpServersByLocalEnabled(this.sourceMcpServers);
  }

  /**
   * Filter MCP servers based on whether local (stdio) MCP is enabled for this workspace.
   * When local MCP is disabled, stdio servers are filtered out.
   *
   * @returns Object with filtered servers and names of any skipped stdio servers
   */
  private filterMcpServersByLocalEnabled(
    servers: Record<string, SdkMcpServerConfig>
  ): { servers: Record<string, SdkMcpServerConfig>; skipped: string[] } {
    const localEnabled = isLocalMcpEnabled(this.workspaceRootPath);

    if (localEnabled) {
      // Local MCP is enabled, return all servers
      return { servers, skipped: [] };
    }

    // Local MCP is disabled, filter out stdio servers
    const filtered: Record<string, SdkMcpServerConfig> = {};
    const skipped: string[] = [];
    for (const [name, config] of Object.entries(servers)) {
      if (config.type !== 'stdio') {
        filtered[name] = config;
      } else {
        debug(`[filterMcpServers] Filtering out stdio server "${name}" (local MCP disabled)`);
        skipped.push(name);
      }
    }
    return { servers: filtered, skipped };
  }

  async close(): Promise<void> {
    this.forceAbort();
    await this.provider.cleanup();
    this.stopHeartbeatManager();
  }

  /**
   * Dispose the agent instance and clean up all resources.
   * Called when the session ends (component unmount).
   * Clears all instance state and module-level callbacks that reference this instance.
   */
  dispose(): void {
    this.forceAbort();
    this.stopHeartbeatManager();

    // Clear pending operations
    this.pendingPermissions.clear();

    // Clear security whitelists
    this.alwaysAllowedCommands.clear();
    this.alwaysAllowedDomains.clear();

    // Clear pinned system prompt state
    this.pinnedPreferencesPrompt = null;
    this.preferencesDriftNotified = false;

    // Clear callbacks
    this.onPermissionRequest = null;
    this.onDebug = null;
    this.onPlanSubmitted = null;
    this.onAuthRequest = null;
    this.onSourceChange = null;
    this.onSourcesListChange = null;
    this.onConfigValidationError = null;
    this.onSourceActivationRequest = null;

    // Stop config watcher
    this.stopConfigWatcher();

    // Clean up session-specific state
    const configSessionId = this.config.session?.id;
    if (configSessionId) {
      cleanupModeState(configSessionId);
      cleanupSessionScopedTools(configSessionId);
    }

    // Clear session
    this.sessionId = null;
  }
}
