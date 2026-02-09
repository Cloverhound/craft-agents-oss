# Multi-Provider Agent Support: OpenAI Codex Integration

## Executive Summary

This plan adds OpenAI Codex SDK support to Craft Agent, enabling users to switch between Claude and Codex on a per-session basis. The architecture leverages the fact that both SDKs wrap CLI subprocesses with similar capabilities, making integration more straightforward than initially expected.

**Key Goals:**
1. Abstract provider-specific logic behind a common interface
2. Support both Claude Agent SDK and OpenAI Codex SDK
3. Enable provider selection at session creation and mid-session switching
4. Maintain backward compatibility with existing sessions
5. Support headless testing for both providers

---

## Architecture Overview

### Current State
```
CraftAgent
    ↓
Claude Agent SDK (query())
    ↓
Claude Code CLI (subprocess)
    ↓
Anthropic API
```

### Target State
```
CraftAgent
    ↓
AgentProvider Interface
    ↓           ↓
ClaudeProvider    CodexProvider
    ↓                 ↓
Claude Agent SDK    Codex SDK
    ↓                 ↓
Claude Code CLI    Codex CLI
    ↓                 ↓
Anthropic API      OpenAI API
```

---

## Phase 1: Provider Abstraction & Headless Testing Infrastructure

### Goals
1. Create a provider-agnostic interface that normalizes SDK interactions
2. Extract existing Claude SDK logic into a provider implementation
3. Enable comprehensive headless testing for provider implementations
4. Validate the abstraction layer with extensive testing

### 1.1 Define Provider Interface

**File:** `packages/shared/src/agent/providers/types.ts`

```typescript
import type { AgentEvent } from '@craft-agent/core/types';
import type { FileAttachment } from '../../utils/files.ts';
import type { PermissionMode } from '../mode-manager.ts';

/**
 * Unified provider interface for agent execution.
 * Both Claude and Codex providers implement this.
 */
export interface AgentProvider {
  /**
   * Provider identifier (claude, codex)
   */
  readonly type: ProviderType;

  /**
   * Initialize the provider with workspace config
   */
  initialize(config: ProviderConfig): Promise<void>;

  /**
   * Execute a chat query with streaming events
   */
  chat(params: ChatParams): AsyncGenerator<AgentEvent>;

  /**
   * Resume from a previous session
   */
  resume(sessionId: string): Promise<boolean>;

  /**
   * Cleanup resources (terminate CLI subprocess, etc.)
   */
  cleanup(): Promise<void>;

  /**
   * Check if provider supports a feature
   */
  supports(feature: ProviderFeature): boolean;
}

export type ProviderType = 'claude' | 'codex';

export type ProviderFeature =
  | 'extended_thinking'
  | 'vision'
  | 'native_mcp'
  | 'tool_choice'
  | 'streaming';

export interface ProviderConfig {
  workspace: Workspace;
  model?: string;
  permissionMode: PermissionMode;
  debugMode?: boolean;
  isHeadless?: boolean;
  workingDirectory?: string;

  // Provider-specific options
  cliPath?: string;          // Custom CLI path
  apiKey?: string;           // API key or auth token
  thinkingLevel?: ThinkingLevel;
}

export interface ChatParams {
  message: string;
  attachments?: FileAttachment[];
  sessionId?: string;

  // Callbacks
  onPermissionRequest?: (request: PermissionRequest) => Promise<boolean>;
  onAuthRequest?: (request: AuthRequest) => Promise<void>;
  onPlanSubmitted?: (planPath: string) => Promise<void>;
}

export interface ProviderCapabilities {
  maxContextTokens: number;
  supportsThinking: boolean;
  supportsVision: boolean;
  supportsNativeMcp: boolean;
  supportedFileTypes: string[];
}
```

### 1.2 Implement Claude Provider

**File:** `packages/shared/src/agent/providers/claude-provider.ts`

Extract existing CraftAgent logic into a provider implementation:

```typescript
import { query, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentProvider, ProviderConfig, ChatParams } from './types.ts';
import type { AgentEvent } from '@craft-agent/core/types';
import { normalizeClaudeEvent } from './event-normalizer.ts';

export class ClaudeProvider implements AgentProvider {
  readonly type = 'claude';
  private config: ProviderConfig | null = null;
  private currentSession: Query | null = null;

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
    // Initialize Claude-specific setup (API key, base URL, etc.)
  }

  async *chat(params: ChatParams): AsyncGenerator<AgentEvent> {
    if (!this.config) {
      throw new Error('Provider not initialized');
    }

    // Build Claude query options
    const queryOptions = this.buildQueryOptions(params);

    // Execute query via Claude Agent SDK
    for await (const sdkMessage of query(queryOptions)) {
      // Normalize Claude SDK message to AgentEvent
      const event = normalizeClaudeEvent(sdkMessage);
      if (event) {
        yield event;
      }
    }
  }

  async resume(sessionId: string): Promise<boolean> {
    // Implement session resumption using Claude SDK
    return true;
  }

  async cleanup(): Promise<void> {
    this.currentSession = null;
  }

  supports(feature: ProviderFeature): boolean {
    return {
      extended_thinking: true,
      vision: true,
      native_mcp: true,
      tool_choice: true,
      streaming: true,
    }[feature] ?? false;
  }

  private buildQueryOptions(params: ChatParams): any {
    // Transform params to Claude SDK query options
    // This is where existing CraftAgent logic moves
  }
}
```

### 1.3 Event Normalization

**File:** `packages/shared/src/agent/providers/event-normalizer.ts`

```typescript
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CodexEvent } from '@openai/codex-sdk';
import type { AgentEvent } from '@craft-agent/core/types';

/**
 * Normalize Claude SDK messages to AgentEvents
 */
export function normalizeClaudeEvent(message: SDKMessage): AgentEvent | null {
  // Map Claude SDK message types to AgentEvent
  switch (message.type) {
    case 'text':
      return { type: 'text_delta', text: message.text };

    case 'tool_use':
      return {
        type: 'tool_call',
        id: message.id,
        name: message.name,
        input: message.input,
      };

    case 'tool_result':
      return {
        type: 'tool_result',
        id: message.tool_use_id,
        result: message.content,
        isError: message.is_error ?? false,
      };

    // ... other message types

    default:
      return null;
  }
}

/**
 * Normalize Codex SDK events to AgentEvents
 */
export function normalizeCodexEvent(event: CodexEvent): AgentEvent | null {
  // Map Codex event types to AgentEvent
  switch (event.type) {
    case 'text_delta':
      return { type: 'text_delta', text: event.delta };

    case 'tool_call':
      return {
        type: 'tool_call',
        id: event.id,
        name: event.tool,
        input: event.args,
      };

    case 'file_change':
      return {
        type: 'file_change',
        path: event.path,
        operation: event.operation,
      };

    // ... other event types

    default:
      return null;
  }
}
```

### 1.4 Update CraftAgent to Use Providers

**File:** `packages/shared/src/agent/craft-agent.ts`

Refactor CraftAgent to delegate to providers:

```typescript
import type { AgentProvider, ProviderType } from './providers/types.ts';
import { ClaudeProvider } from './providers/claude-provider.ts';
import { createProvider } from './providers/factory.ts';

export class CraftAgent {
  private provider: AgentProvider;

  constructor(config: CraftAgentConfig) {
    // Determine provider from config
    const providerType: ProviderType = config.provider ?? 'claude';

    // Create provider instance
    this.provider = createProvider(providerType);

    // Initialize provider
    await this.provider.initialize({
      workspace: config.workspace,
      model: config.model,
      permissionMode: config.permissionMode ?? 'ask',
      debugMode: config.debugMode,
      isHeadless: config.isHeadless,
      workingDirectory: config.workingDirectory,
    });
  }

  async *chat(message: string, attachments?: FileAttachment[]): AsyncGenerator<AgentEvent> {
    // Delegate to provider
    for await (const event of this.provider.chat({ message, attachments })) {
      yield event;
    }
  }

  // Other methods delegate to provider...
}
```

### 1.5 Provider Factory

**File:** `packages/shared/src/agent/providers/factory.ts`

```typescript
import type { AgentProvider, ProviderType } from './types.ts';
import { ClaudeProvider } from './claude-provider.ts';

export function createProvider(type: ProviderType): AgentProvider {
  switch (type) {
    case 'claude':
      return new ClaudeProvider();

    case 'codex':
      // Will implement in Phase 2
      throw new Error('Codex provider not yet implemented');

    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}

export function getSupportedProviders(): ProviderType[] {
  return ['claude', 'codex'];
}

export function getProviderDisplayName(type: ProviderType): string {
  return {
    claude: 'Claude (Anthropic)',
    codex: 'Codex (OpenAI)',
  }[type];
}
```

### 1.6 Headless Testing Infrastructure

**File:** `packages/shared/src/headless/runner.ts`

Update HeadlessRunner to support provider abstraction:

```typescript
export class HeadlessRunner {
  private provider: AgentProvider | null = null;

  constructor(config: HeadlessConfig) {
    this.config = config;
  }

  private async createAgent(): Promise<void> {
    // Determine provider from config
    const providerType = this.config.provider ?? 'claude';

    // Create provider instance
    this.provider = createProvider(providerType);

    // Initialize provider with headless config
    await this.provider.initialize({
      workspace: this.config.workspace,
      model: this.config.model,
      permissionMode: policyToPermissionMode(this.config.permissionPolicy),
      isHeadless: true,
      debugMode: this.config.debugMode,
      workingDirectory: this.config.workspace.rootPath,
    });
  }

  async *runStreaming(): AsyncGenerator<HeadlessEvent> {
    try {
      // Initialize provider
      await this.createAgent();

      if (!this.provider) {
        throw new Error('Failed to initialize provider');
      }

      // Execute query via provider
      let response = '';
      const toolCalls: ToolCallRecord[] = [];

      for await (const event of this.provider.chat({
        message: this.config.prompt,
        attachments: this.config.attachments,
        onPermissionRequest: this.handlePermissionRequest.bind(this),
      })) {
        // Transform AgentEvent to HeadlessEvent
        const headlessEvent = this.transformEvent(event);
        if (headlessEvent) {
          yield headlessEvent;
        }

        // Track response and tool calls
        if (event.type === 'text_delta') {
          response += event.text;
        } else if (event.type === 'tool_result') {
          toolCalls.push({
            id: event.id,
            name: event.name,
            input: event.input,
            result: event.result,
            isError: event.isError,
          });
        }
      }

      // Emit completion
      yield {
        type: 'complete',
        result: {
          success: true,
          response,
          toolCalls,
          usage: this.calculateUsage(),
        },
      };
    } catch (error) {
      yield {
        type: 'error',
        message: error.message,
      };
      yield {
        type: 'complete',
        result: {
          success: false,
          error: {
            code: 'execution_error',
            message: error.message,
          },
        },
      };
    } finally {
      // Cleanup provider
      await this.provider?.cleanup();
    }
  }

  private transformEvent(event: AgentEvent): HeadlessEvent | null {
    switch (event.type) {
      case 'text_delta':
        return { type: 'text_delta', text: event.text };

      case 'tool_call':
        return {
          type: 'tool_start',
          id: event.id,
          name: event.name,
          input: event.input,
        };

      case 'tool_result':
        return {
          type: 'tool_result',
          id: event.id,
          name: event.name,
          result: event.result,
          isError: event.isError,
        };

      default:
        return null;
    }
  }

  private async handlePermissionRequest(request: PermissionRequest): Promise<boolean> {
    // Auto-handle based on policy
    const policy = this.config.permissionPolicy ?? 'deny-all';

    switch (policy) {
      case 'allow-all':
        return true;

      case 'allow-safe':
        // Check if tool is in safe list
        return this.isToolSafe(request.toolName);

      case 'deny-all':
      default:
        return false;
    }
  }

  private isToolSafe(toolName: string): boolean {
    const safeTools = ['read', 'glob', 'grep', 'git status', 'git log', 'git diff'];
    return safeTools.includes(toolName);
  }
}
```

### 1.7 Headless Testing Scripts

**File:** `scripts/test-provider-headless.ts`

```typescript
#!/usr/bin/env bun
import { HeadlessRunner } from '@craft-agent/shared/headless';
import { loadStoredConfig } from '@craft-agent/shared/config';

/**
 * Test provider functionality in headless mode.
 * This script validates that the provider abstraction works correctly.
 *
 * Usage:
 *   bun scripts/test-provider-headless.ts "List all TypeScript files"
 */
async function main() {
  const prompt = process.argv[2];
  if (!prompt) {
    console.error('Usage: bun scripts/test-provider-headless.ts "<prompt>"');
    process.exit(1);
  }

  // Load workspace
  const config = await loadStoredConfig();
  const workspace = config.workspaces[0];

  console.log('🧪 Testing Claude provider in headless mode...\n');

  // Create headless runner
  const runner = new HeadlessRunner({
    prompt,
    workspace,
    provider: 'claude',
    permissionPolicy: 'allow-safe',
    outputFormat: 'stream-json',
  });

  // Run with streaming
  for await (const event of runner.runStreaming()) {
    switch (event.type) {
      case 'status':
        console.log(`📊 ${event.message}`);
        break;

      case 'text_delta':
        process.stdout.write(event.text);
        break;

      case 'tool_start':
        console.log(`\n🔧 ${event.name}(${JSON.stringify(event.input, null, 2)})`);
        break;

      case 'tool_result':
        const preview = event.result.slice(0, 200);
        console.log(`✅ Result: ${preview}${event.result.length > 200 ? '...' : ''}`);
        break;

      case 'error':
        console.error(`\n❌ Error: ${event.message}`);
        break;

      case 'complete':
        if (event.result.success) {
          console.log('\n\n✅ Test passed!');
          console.log(`📊 Tools used: ${event.result.toolCalls?.length ?? 0}`);
          if (event.result.usage) {
            console.log(`📊 Tokens: ${event.result.usage.inputTokens} in / ${event.result.usage.outputTokens} out`);
          }
        } else {
          console.error('\n\n❌ Test failed!');
          console.error(event.result.error);
          process.exit(1);
        }
        break;
    }
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
```

### 1.8 Provider Integration Tests

**File:** `packages/shared/src/agent/__tests__/provider-abstraction.test.ts`

```typescript
import { describe, test, expect, beforeAll } from 'bun:test';
import { createProvider } from '../providers/factory.ts';
import { ClaudeProvider } from '../providers/claude-provider.ts';
import { normalizeClaudeEvent } from '../providers/event-normalizer.ts';
import type { ProviderConfig } from '../providers/types.ts';

describe('Provider Abstraction Layer', () => {
  const testConfig: ProviderConfig = {
    workspace: {
      id: 'test-workspace',
      rootPath: '/tmp/test',
      // ... other workspace fields
    },
    permissionMode: 'ask',
    isHeadless: true,
  };

  describe('Provider Factory', () => {
    test('creates Claude provider', () => {
      const provider = createProvider('claude');
      expect(provider).toBeInstanceOf(ClaudeProvider);
      expect(provider.type).toBe('claude');
    });

    test('throws for unknown provider', () => {
      expect(() => createProvider('unknown' as any)).toThrow();
    });
  });

  describe('Claude Provider', () => {
    test('initializes successfully', async () => {
      const provider = createProvider('claude');
      await expect(provider.initialize(testConfig)).resolves.not.toThrow();
    });

    test('supports expected features', () => {
      const provider = createProvider('claude');
      expect(provider.supports('extended_thinking')).toBe(true);
      expect(provider.supports('vision')).toBe(true);
      expect(provider.supports('native_mcp')).toBe(true);
      expect(provider.supports('streaming')).toBe(true);
    });

    test('chat returns AsyncGenerator', async () => {
      const provider = createProvider('claude');
      await provider.initialize(testConfig);

      const generator = provider.chat({
        message: 'Hello',
        attachments: [],
      });

      expect(generator).toBeDefined();
      expect(typeof generator[Symbol.asyncIterator]).toBe('function');

      await provider.cleanup();
    });
  });

  describe('Event Normalization', () => {
    test('normalizes text message', () => {
      const claudeMsg = { type: 'text', text: 'Hello world' };
      const event = normalizeClaudeEvent(claudeMsg);

      expect(event).toBeDefined();
      expect(event?.type).toBe('text_delta');
      expect(event?.text).toBe('Hello world');
    });

    test('normalizes tool_use message', () => {
      const claudeMsg = {
        type: 'tool_use',
        id: 'tool_123',
        name: 'read',
        input: { file_path: '/test.ts' },
      };
      const event = normalizeClaudeEvent(claudeMsg);

      expect(event).toBeDefined();
      expect(event?.type).toBe('tool_call');
      expect(event?.id).toBe('tool_123');
      expect(event?.name).toBe('read');
    });

    test('normalizes tool_result message', () => {
      const claudeMsg = {
        type: 'tool_result',
        tool_use_id: 'tool_123',
        content: 'File contents...',
        is_error: false,
      };
      const event = normalizeClaudeEvent(claudeMsg);

      expect(event).toBeDefined();
      expect(event?.type).toBe('tool_result');
      expect(event?.id).toBe('tool_123');
      expect(event?.isError).toBe(false);
    });

    test('returns null for unknown message type', () => {
      const claudeMsg = { type: 'unknown' };
      const event = normalizeClaudeEvent(claudeMsg);
      expect(event).toBeNull();
    });
  });
});
```

### 1.9 End-to-End Headless Tests

**File:** `packages/shared/src/agent/__tests__/headless-e2e.test.ts`

```typescript
import { describe, test, expect } from 'bun:test';
import { HeadlessRunner } from '../../headless/runner.ts';
import { loadStoredConfig } from '../../config/storage.ts';

describe('Headless End-to-End Tests', () => {
  const workspace = {
    id: 'test',
    rootPath: process.cwd(),
    // ... minimal workspace config
  };

  test('executes simple query successfully', async () => {
    const runner = new HeadlessRunner({
      prompt: 'What is 2 + 2?',
      workspace,
      provider: 'claude',
      permissionPolicy: 'deny-all', // No tools needed
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.response).toBeDefined();
    expect(result.response).toContain('4');
  });

  test('handles tool execution with allow-safe policy', async () => {
    const runner = new HeadlessRunner({
      prompt: 'List files in the current directory',
      workspace,
      provider: 'claude',
      permissionPolicy: 'allow-safe',
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBeGreaterThan(0);
  });

  test('respects deny-all policy', async () => {
    const runner = new HeadlessRunner({
      prompt: 'Delete the file test.txt',
      workspace,
      provider: 'claude',
      permissionPolicy: 'deny-all',
    });

    const result = await runner.run();

    // Should either refuse to use tools or explicitly state it cannot
    expect(result.success).toBe(true);
    expect(result.toolCalls?.length ?? 0).toBe(0);
  });

  test('streams events in correct order', async () => {
    const runner = new HeadlessRunner({
      prompt: 'Say hello',
      workspace,
      provider: 'claude',
      permissionPolicy: 'deny-all',
    });

    const events: string[] = [];

    for await (const event of runner.runStreaming()) {
      events.push(event.type);

      if (event.type === 'complete') {
        expect(event.result.success).toBe(true);
      }
    }

    // Verify event flow
    expect(events).toContain('status');
    expect(events).toContain('text_delta');
    expect(events).toContain('complete');
    expect(events[events.length - 1]).toBe('complete');
  });
});
```

**Phase 1 Deliverables:**
- [ ] Provider interface definition
- [ ] ClaudeProvider implementation
- [ ] Event normalization utilities
- [ ] Provider factory
- [ ] Updated CraftAgent using providers
- [ ] Headless testing infrastructure supporting providers
- [ ] Headless testing scripts
- [ ] Comprehensive integration tests
- [ ] End-to-end tests validating abstraction

**Phase 1 Testing Requirements:**
- [ ] All existing CraftAgent tests pass with provider abstraction
- [ ] Headless tests pass for Claude provider
- [ ] Event normalization tests pass
- [ ] No regressions in UI functionality
- [ ] Session resumption works correctly
- [ ] Permission system works with provider abstraction
- [ ] MCP sources work with provider abstraction

---

## Phase 2: Codex Provider Implementation

### Goals
1. Implement CodexProvider following the established interface
2. Handle Codex-specific authentication and CLI requirements
3. Bridge MCP servers to Codex tool format
4. Validate with extensive headless testing

### 2.1 Add Codex SDK Dependency

**File:** `package.json`

```json
{
  "dependencies": {
    "@openai/codex-sdk": "^0.98.0"
  }
}
```

### 2.2 Implement Codex Provider

**File:** `packages/shared/src/agent/providers/codex-provider.ts`

```typescript
import { Codex, type CodexEvent, type Thread } from '@openai/codex-sdk';
import type { AgentProvider, ProviderConfig, ChatParams } from './types.ts';
import type { AgentEvent } from '@craft-agent/core/types';
import { normalizeCodexEvent } from './event-normalizer.ts';

export class CodexProvider implements AgentProvider {
  readonly type = 'codex';
  private config: ProviderConfig | null = null;
  private codex: Codex | null = null;
  private currentThread: Thread | null = null;

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;

    // Initialize Codex SDK
    this.codex = new Codex({
      cliPath: config.cliPath, // Optional custom CLI path
      // Codex SDK uses authenticated CLI, no API key needed
    });

    // Verify CLI is authenticated
    await this.verifyAuthentication();
  }

  async *chat(params: ChatParams): AsyncGenerator<AgentEvent> {
    if (!this.codex || !this.config) {
      throw new Error('Provider not initialized');
    }

    // Start or resume thread
    if (params.sessionId && this.currentThread) {
      // Resume existing thread
      this.currentThread = this.codex.resumeThread(params.sessionId);
    } else {
      // Start new thread
      this.currentThread = this.codex.startThread({
        workingDirectory: this.config.workingDirectory,
      });
    }

    // Execute query with streaming
    for await (const codexEvent of this.currentThread.runStreamed(params.message)) {
      // Handle permission requests
      if (codexEvent.type === 'tool_call') {
        const allowed = await this.checkPermission(codexEvent, params);
        if (!allowed) {
          // Abort tool execution
          throw new Error('Tool execution denied by permission policy');
        }
      }

      // Normalize Codex event to AgentEvent
      const event = normalizeCodexEvent(codexEvent);
      if (event) {
        yield event;
      }
    }
  }

  async resume(sessionId: string): Promise<boolean> {
    if (!this.codex) return false;

    try {
      this.currentThread = this.codex.resumeThread(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  async cleanup(): Promise<void> {
    this.currentThread = null;
    this.codex = null;
  }

  supports(feature: ProviderFeature): boolean {
    return {
      extended_thinking: false, // Codex doesn't support thinking tokens
      vision: true,             // Via GPT-4o
      native_mcp: false,        // Codex uses tools, not native MCP
      tool_choice: true,
      streaming: true,
    }[feature] ?? false;
  }

  private async verifyAuthentication(): Promise<void> {
    // Check if Codex CLI is authenticated
    // Throw error if not authenticated with helpful message
  }

  private async checkPermission(
    event: CodexEvent,
    params: ChatParams
  ): Promise<boolean> {
    if (!params.onPermissionRequest) return true;

    // Transform Codex tool call to permission request
    const request = {
      toolName: event.tool,
      toolInput: event.args,
      reason: 'Codex wants to execute a tool',
    };

    return await params.onPermissionRequest(request);
  }
}
```

### 2.3 MCP Bridge for Codex

**File:** `packages/shared/src/agent/providers/codex-mcp-bridge.ts`

Since Codex doesn't natively support MCP, create a bridge layer:

```typescript
import type { Thread } from '@openai/codex-sdk';
import type { LoadedSource } from '../../sources/types.ts';

/**
 * Bridge MCP servers to Codex as custom tools.
 * Converts MCP tool definitions to Codex tool format.
 */
export class CodexMcpBridge {
  /**
   * Register MCP sources as Codex tools
   */
  static registerMcpSources(thread: Thread, sources: LoadedSource[]): void {
    for (const source of sources) {
      if (source.type !== 'mcp') continue;

      // Get MCP tools
      const mcpTools = source.client?.listTools() ?? [];

      // Convert each MCP tool to Codex tool format
      for (const mcpTool of mcpTools) {
        const codexTool = this.convertMcpToolToCodex(mcpTool, source);
        thread.addCustomTool(codexTool);
      }
    }
  }

  private static convertMcpToolToCodex(mcpTool: any, source: LoadedSource): any {
    return {
      name: `${source.slug}__${mcpTool.name}`,
      description: mcpTool.description,
      parameters: mcpTool.inputSchema,
      execute: async (args: any) => {
        // Call MCP tool via source client
        return await source.client.callTool(mcpTool.name, args);
      },
    };
  }
}
```

### 2.4 Authentication Flow

**File:** `packages/shared/src/agent/providers/codex-auth.ts`

```typescript
/**
 * Verify Codex CLI authentication status.
 * Codex requires ChatGPT Pro/Team/Enterprise subscription.
 */
export async function verifyCodexAuth(): Promise<AuthStatus> {
  try {
    // Try to spawn Codex CLI with --version
    const { stdout } = await exec('codex --version');

    // Check if authenticated
    const { stdout: authCheck } = await exec('codex auth status');

    if (authCheck.includes('Authenticated')) {
      return { authenticated: true };
    } else {
      return {
        authenticated: false,
        message: 'Codex CLI not authenticated. Run: codex auth login',
      };
    }
  } catch (error) {
    return {
      authenticated: false,
      message: 'Codex CLI not found. Install from: https://openai.com/codex',
      installRequired: true,
    };
  }
}

export interface AuthStatus {
  authenticated: boolean;
  message?: string;
  installRequired?: boolean;
}
```

### 2.5 Update Provider Factory

**File:** `packages/shared/src/agent/providers/factory.ts`

```typescript
import { CodexProvider } from './codex-provider.ts';

export function createProvider(type: ProviderType): AgentProvider {
  switch (type) {
    case 'claude':
      return new ClaudeProvider();

    case 'codex':
      return new CodexProvider(); // ✅ Now implemented

    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}
```

### 2.6 Codex-Specific Tests

**File:** `packages/shared/src/agent/__tests__/codex-provider.test.ts`

```typescript
import { describe, test, expect, beforeAll } from 'bun:test';
import { CodexProvider } from '../providers/codex-provider.ts';
import { verifyCodexAuth } from '../providers/codex-auth.ts';
import { normalizeCodexEvent } from '../providers/event-normalizer.ts';

describe('Codex Provider', () => {
  beforeAll(async () => {
    // Verify Codex is available before running tests
    const authStatus = await verifyCodexAuth();
    if (!authStatus.authenticated) {
      console.warn('⚠️  Codex not authenticated, skipping Codex tests');
      return;
    }
  });

  test('initializes successfully', async () => {
    const provider = new CodexProvider();
    await expect(provider.initialize(testConfig)).resolves.not.toThrow();
    await provider.cleanup();
  });

  test('reports correct feature support', () => {
    const provider = new CodexProvider();
    expect(provider.supports('extended_thinking')).toBe(false); // Codex doesn't support thinking
    expect(provider.supports('vision')).toBe(true);
    expect(provider.supports('native_mcp')).toBe(false); // Uses bridge
    expect(provider.supports('streaming')).toBe(true);
  });

  test('chat returns AsyncGenerator', async () => {
    const provider = new CodexProvider();
    await provider.initialize(testConfig);

    const generator = provider.chat({
      message: 'Hello',
      attachments: [],
    });

    expect(generator).toBeDefined();
    expect(typeof generator[Symbol.asyncIterator]).toBe('function');

    await provider.cleanup();
  });

  test('normalizes Codex events correctly', () => {
    const codexEvent = {
      type: 'text_delta',
      delta: 'Hello',
    };

    const normalized = normalizeCodexEvent(codexEvent);
    expect(normalized?.type).toBe('text_delta');
    expect(normalized?.text).toBe('Hello');
  });
});
```

### 2.7 Headless Tests with Codex

**File:** `scripts/test-codex-headless.ts`

```typescript
#!/usr/bin/env bun
import { HeadlessRunner } from '@craft-agent/shared/headless';
import { loadStoredConfig } from '@craft-agent/shared/config';
import { verifyCodexAuth } from '@craft-agent/shared/agent/providers/codex-auth';

async function main() {
  // Check Codex availability
  console.log('🔍 Checking Codex authentication...');
  const authStatus = await verifyCodexAuth();

  if (!authStatus.authenticated) {
    console.error('❌ Codex not authenticated');
    console.error(authStatus.message);
    if (authStatus.installRequired) {
      console.error('\nInstall Codex: npm install -g @openai/codex');
      console.error('Authenticate: codex auth login');
    }
    process.exit(1);
  }

  console.log('✅ Codex authenticated\n');

  // Load workspace
  const config = await loadStoredConfig();
  const workspace = config.workspaces[0];

  const prompt = process.argv[2] ?? 'List all TypeScript files in src/';

  console.log(`🧪 Testing Codex provider: "${prompt}"\n`);

  const runner = new HeadlessRunner({
    prompt,
    workspace,
    provider: 'codex',
    permissionPolicy: 'allow-safe',
    outputFormat: 'stream-json',
  });

  for await (const event of runner.runStreaming()) {
    switch (event.type) {
      case 'text_delta':
        process.stdout.write(event.text);
        break;

      case 'tool_start':
        console.log(`\n🔧 ${event.name}`);
        break;

      case 'tool_result':
        console.log(`✅ Done`);
        break;

      case 'complete':
        if (event.result.success) {
          console.log('\n\n✅ Codex test passed!');
        } else {
          console.error('\n\n❌ Test failed:', event.result.error);
          process.exit(1);
        }
        break;
    }
  }
}

main().catch(console.error);
```

### 2.8 Provider Comparison Tests

**File:** `scripts/compare-providers.ts`

```typescript
#!/usr/bin/env bun
import { HeadlessRunner } from '@craft-agent/shared/headless';
import { loadStoredConfig } from '@craft-agent/shared/config';

/**
 * Run identical queries with both providers and compare results.
 * Validates that both providers work correctly and produce reasonable outputs.
 */
async function main() {
  const prompt = process.argv[2] ?? 'Write a function to check if a number is prime';

  console.log(`📊 Comparing providers with prompt: "${prompt}"\n`);

  const config = await loadStoredConfig();
  const workspace = config.workspaces[0];

  // Test Claude
  console.log('📘 Testing Claude...');
  const claudeStart = Date.now();
  const claudeResult = await testProvider('claude', prompt, workspace);
  const claudeDuration = Date.now() - claudeStart;

  // Test Codex
  console.log('\n📗 Testing Codex...');
  const codexStart = Date.now();
  const codexResult = await testProvider('codex', prompt, workspace);
  const codexDuration = Date.now() - codexStart;

  // Compare
  console.log('\n\n📊 Comparison Results:');
  console.log('─'.repeat(80));
  console.log(`Provider        │ Status │ Length │ Tools │ Duration`);
  console.log('─'.repeat(80));
  console.log(
    `Claude          │ ${claudeResult.success ? '✅' : '❌'}     │ ${claudeResult.response?.length ?? 0} │ ${claudeResult.toolCalls?.length ?? 0} │ ${claudeDuration}ms`
  );
  console.log(
    `Codex           │ ${codexResult.success ? '✅' : '❌'}     │ ${codexResult.response?.length ?? 0} │ ${codexResult.toolCalls?.length ?? 0} │ ${codexDuration}ms`
  );
  console.log('─'.repeat(80));
}

async function testProvider(provider: 'claude' | 'codex', prompt: string, workspace: any) {
  const runner = new HeadlessRunner({
    prompt,
    workspace,
    provider,
    permissionPolicy: 'allow-safe',
  });

  try {
    return await runner.run();
  } catch (error) {
    return {
      success: false,
      error: { code: 'execution_error', message: error.message },
    };
  }
}

main().catch(console.error);
```

**Phase 2 Deliverables:**
- [ ] Install @openai/codex-sdk dependency
- [ ] CodexProvider implementation
- [ ] MCP bridge for Codex
- [ ] Codex authentication verification
- [ ] Event normalization for Codex events
- [ ] Codex-specific unit tests
- [ ] Headless tests with Codex provider
- [ ] Provider comparison testing scripts

**Phase 2 Testing Requirements:**
- [ ] All provider abstraction tests pass with Codex
- [ ] Headless tests pass for Codex provider
- [ ] Codex authentication verification works
- [ ] MCP bridge correctly translates tools
- [ ] Event normalization handles all Codex event types
- [ ] Permission system works with Codex
- [ ] Side-by-side comparison shows both providers functional

---

## Phase 3: Configuration & UI Integration

### Goals
1. Add provider selection to configuration and session metadata
2. Implement UI controls for provider selection
3. Enable provider switching within sessions
4. Update settings and preferences UI

### 3.1 Update Type Definitions

**File:** `packages/core/src/types/session.ts`

```typescript
export interface Session {
  id: string;
  workspaceId: string;
  createdAt: number;
  lastUsedAt: number;

  // NEW: Provider selection
  provider?: 'claude' | 'codex';

  // Existing fields
  model?: string;
  permissionMode?: PermissionMode;
  workingDirectory?: string;
  sdkSessionId?: string;
}
```

### 3.2 Update Session Creation

**File:** `apps/electron/src/main/sessions.ts`

```typescript
export async function createSession(
  workspaceId: string,
  options?: {
    model?: string;
    provider?: 'claude' | 'codex'; // NEW
    permissionMode?: PermissionMode;
    workingDirectory?: string;
  }
): Promise<Session> {
  const session: Session = {
    id: generateSessionId(),
    workspaceId,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    provider: options?.provider ?? 'claude', // Default to Claude
    model: options?.model,
    permissionMode: options?.permissionMode ?? 'ask',
    workingDirectory: options?.workingDirectory,
  };

  await saveSession(session);
  return session;
}
```

### 3.3 Provider Switching

**File:** `packages/shared/src/agent/provider-manager.ts`

```typescript
/**
 * Manage provider switching within a session.
 */
export class ProviderManager {
  /**
   * Switch provider mid-session.
   * Creates a new agent instance with the new provider.
   */
  static async switchProvider(
    sessionId: string,
    newProvider: ProviderType
  ): Promise<void> {
    const session = await loadSession(sessionId);

    // Update session metadata
    session.provider = newProvider;
    await saveSession(session);

    // Trigger agent recreation
    // (handled by SessionManager.getOrCreateAgent)
  }

  /**
   * Get available providers based on environment.
   */
  static async getAvailableProviders(): Promise<ProviderInfo[]> {
    const providers: ProviderInfo[] = [];

    // Claude is always available (uses API key)
    providers.push({
      type: 'claude',
      name: 'Claude',
      available: true,
      models: ['claude-opus-4', 'claude-sonnet-4.5', 'claude-haiku-4'],
    });

    // Check Codex availability
    const codexAuth = await verifyCodexAuth();
    providers.push({
      type: 'codex',
      name: 'Codex',
      available: codexAuth.authenticated,
      authRequired: !codexAuth.authenticated,
      authMessage: codexAuth.message,
      models: ['gpt-5.3-codex', 'gpt-5.2-codex'],
    });

    return providers;
  }
}

export interface ProviderInfo {
  type: ProviderType;
  name: string;
  available: boolean;
  authRequired?: boolean;
  authMessage?: string;
  models: string[];
}
```

### 3.4 Model Selection Updates

**File:** `packages/shared/src/config/models.ts`

```typescript
export const CLAUDE_MODELS = [
  'claude-opus-4',
  'claude-sonnet-4.5',
  'claude-haiku-4',
] as const;

export const CODEX_MODELS = [
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-4o', // General-purpose model
] as const;

export function getModelsForProvider(provider: ProviderType): string[] {
  return provider === 'claude' ? CLAUDE_MODELS : CODEX_MODELS;
}

export function detectProviderFromModel(model: string): ProviderType {
  if (CLAUDE_MODELS.includes(model as any)) return 'claude';
  if (CODEX_MODELS.includes(model as any)) return 'codex';
  // Default to Claude
  return 'claude';
}
```

### 3.3 Provider Manager

### 3.4 Provider Selection in New Session

**File:** `apps/electron/src/renderer/components/new-session-dialog.tsx`

```typescript
export function NewSessionDialog() {
  const [provider, setProvider] = useState<'claude' | 'codex'>('claude');
  const [availableProviders, setAvailableProviders] = useState<ProviderInfo[]>([]);

  useEffect(() => {
    // Load available providers
    ProviderManager.getAvailableProviders().then(setAvailableProviders);
  }, []);

  return (
    <Dialog>
      <DialogContent>
        <h2>New Session</h2>

        {/* Provider Selection */}
        <div>
          <label>Provider</label>
          <Select value={provider} onValueChange={setProvider}>
            {availableProviders.map(p => (
              <SelectItem
                key={p.type}
                value={p.type}
                disabled={!p.available}
              >
                {p.name}
                {!p.available && ' (Not authenticated)'}
              </SelectItem>
            ))}
          </Select>

          {/* Show auth message for unavailable providers */}
          {!availableProviders.find(p => p.type === provider)?.available && (
            <p className="text-sm text-yellow-600">
              {availableProviders.find(p => p.type === provider)?.authMessage}
            </p>
          )}
        </div>

        {/* Model Selection (filtered by provider) */}
        <div>
          <label>Model</label>
          <Select>
            {getModelsForProvider(provider).map(model => (
              <SelectItem key={model} value={model}>
                {model}
              </SelectItem>
            ))}
          </Select>
        </div>

        {/* Existing fields: workspace, permission mode, etc. */}
      </DialogContent>
    </Dialog>
  );
}
```

### 3.5 Provider Indicator in Chat

**File:** `apps/electron/src/renderer/components/chat-header.tsx`

```typescript
export function ChatHeader({ session }: { session: Session }) {
  return (
    <div className="chat-header">
      {/* Provider badge */}
      <Badge variant={session.provider === 'claude' ? 'blue' : 'green'}>
        {session.provider === 'claude' ? '📘 Claude' : '📗 Codex'}
      </Badge>

      {/* Model */}
      <span className="text-sm text-gray-600">
        {session.model ?? 'Default'}
      </span>

      {/* Existing: Permission mode, status, etc. */}
    </div>
  );
}
```

### 3.6 Provider Switching Action

**File:** `apps/electron/src/renderer/components/session-actions.tsx`

```typescript
export function SessionActions({ session }: { session: Session }) {
  const switchProvider = async (newProvider: 'claude' | 'codex') => {
    await ProviderManager.switchProvider(session.id, newProvider);
    // Reload session
  };

  return (
    <DropdownMenu>
      <DropdownMenuItem onClick={() => switchProvider('claude')}>
        Switch to Claude
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => switchProvider('codex')}>
        Switch to Codex
      </DropdownMenuItem>
    </DropdownMenu>
  );
}
```

### 3.7 Settings Page

**File:** `apps/electron/src/renderer/pages/settings.tsx`

Add provider configuration section:

```typescript
export function SettingsPage() {
  return (
    <div>
      <h2>Provider Settings</h2>

      <div>
        <h3>Claude (Anthropic)</h3>
        <p>Status: ✅ Authenticated</p>
        <button>Manage API Key</button>
      </div>

      <div>
        <h3>Codex (OpenAI)</h3>
        {codexAuth.authenticated ? (
          <>
            <p>Status: ✅ Authenticated</p>
            <p>CLI Version: {codexVersion}</p>
          </>
        ) : (
          <>
            <p>Status: ❌ Not authenticated</p>
            <button onClick={openCodexAuth}>
              Authenticate Codex
            </button>
            <p className="text-sm">
              Requires ChatGPT Pro/Team/Enterprise subscription
            </p>
          </>
        )}
      </div>
    </div>
  );
}
```

**Phase 3 Deliverables:**
- [ ] Update session types with provider field
- [ ] Provider selection in session creation
- [ ] Provider switching API
- [ ] Provider availability detection
- [ ] Model selection per provider
- [ ] Migration for existing sessions (default to Claude)
- [ ] Provider selection in new session dialog
- [ ] Provider indicator in chat header
- [ ] Provider switching dropdown
- [ ] Settings page for provider management
- [ ] Authentication status display

**Phase 3 Testing Requirements:**
- [ ] Sessions correctly store and load provider field
- [ ] Provider selection UI works correctly
- [ ] Provider switching preserves session history
- [ ] Model selection filters by provider
- [ ] Settings correctly display authentication status
- [ ] Existing sessions migrate without issues
- [ ] End-to-end UI tests with both providers

---

## Testing Strategy

### Unit Tests
- [ ] Provider interface compliance (Claude, Codex)
- [ ] Event normalization (both directions)
- [ ] Provider factory
- [ ] MCP bridge for Codex
- [ ] Permission hooks with both providers
- [ ] Configuration storage and retrieval

### Integration Tests
- [ ] End-to-end chat with Claude provider (headless)
- [ ] End-to-end chat with Codex provider (headless)
- [ ] Session resumption with both providers
- [ ] Provider switching mid-session
- [ ] Headless execution with both providers
- [ ] MCP source integration with both providers

### Manual UI Testing
- [ ] Create session with Claude
- [ ] Create session with Codex
- [ ] Switch provider mid-session
- [ ] Test tool execution with both
- [ ] Test permission modes with both
- [ ] Test file attachments with both
- [ ] Verify MCP sources work with Codex bridge
- [ ] Settings page authentication status

### Validation Testing
- [ ] Compare response quality (Claude vs Codex)
- [ ] Verify feature parity where applicable
- [ ] Test subprocess cleanup
- [ ] Verify no memory leaks
- [ ] Confirm backward compatibility with existing sessions

---

## Documentation

### Update CLAUDE.md Files

**File:** `packages/shared/CLAUDE.md`

Add section:

```markdown
## Multi-Provider Support

Craft Agent supports multiple AI providers via a unified `AgentProvider` interface:

- **Claude** (via `@anthropic-ai/claude-agent-sdk`)
- **Codex** (via `@openai/codex-sdk`)

### Provider Architecture

All providers implement the `AgentProvider` interface:
- `initialize(config)` - Setup with workspace config
- `chat(params)` - Execute streaming chat
- `resume(sessionId)` - Resume previous session
- `cleanup()` - Cleanup resources
- `supports(feature)` - Feature capability check

### Adding a New Provider

1. Implement `AgentProvider` interface
2. Add to `factory.ts`
3. Implement event normalization
4. Update UI for provider selection
5. Add tests

See `packages/shared/src/agent/providers/` for examples.
```

### User-Facing Documentation

**File:** `apps/online-docs/providers.md`

```markdown
# Using Multiple AI Providers

Craft Agent supports both Claude (Anthropic) and Codex (OpenAI).

## Choosing a Provider

When creating a new session, select your preferred provider:

1. Click "New Session"
2. Choose provider: Claude or Codex
3. Select model
4. Start chatting

## Provider Comparison

| Feature | Claude | Codex |
|---------|--------|-------|
| Extended Thinking | ✅ Yes | ❌ No |
| Vision | ✅ Yes | ✅ Yes |
| Native MCP | ✅ Yes | 🟡 Via bridge |
| Authentication | API Key | ChatGPT login |
| Cost | Pay-as-you-go | Subscription |

## Codex Setup

Codex requires:
1. ChatGPT Pro/Team/Enterprise subscription
2. Codex CLI installed
3. Authentication via `codex auth login`

Install Codex CLI:
```bash
npm install -g @openai/codex
codex auth login
```

## Switching Providers

You can switch providers mid-session:
1. Click session menu (⋮)
2. Select "Switch to [Provider]"
3. Continue conversation

Note: Switching creates a new agent instance but preserves history.
```

### API Documentation

**File:** `packages/shared/API.md`

Document provider API for programmatic use:

```markdown
# Provider API

## Creating an Agent with a Specific Provider

```typescript
import { CraftAgent } from '@craft-agent/shared/agent';

const agent = new CraftAgent({
  workspace,
  provider: 'codex',
  model: 'gpt-5.3-codex',
  permissionMode: 'ask',
});

for await (const event of agent.chat('Fix the bug in auth.ts')) {
  console.log(event);
}
```

## Headless Execution

```typescript
import { HeadlessRunner } from '@craft-agent/shared/headless';

const runner = new HeadlessRunner({
  prompt: 'List all TypeScript files',
  workspace,
  provider: 'claude', // or 'codex'
  permissionPolicy: 'allow-safe',
});

const result = await runner.run();
console.log(result.response);
```
```

---

## Implementation Notes

### Migration & Backward Compatibility

**Existing Sessions:**
- Default to `provider: 'claude'` if not specified
- No breaking changes to existing sessions
- Graceful handling of missing provider field

**Configuration:**
- Add optional `provider` field to session metadata
- No changes to workspace configuration
- Preserve existing model selection behavior

**Code Changes:**
- CraftAgent constructor accepts optional `provider` param
- Defaults to 'claude' for backward compatibility
- All existing code continues to work unchanged

### Key Technical Decisions

**Provider Abstraction:**
- Use interface-based design for maximum flexibility
- Event normalization layer keeps AgentEvent format stable
- Factory pattern for provider instantiation

**Headless Testing:**
- Integrated in Phase 1 to validate abstraction early
- Enables rapid iteration without UI dependencies
- Provides automated regression testing

**MCP Bridge:**
- Codex doesn't natively support MCP, so tools are bridged
- Each MCP tool becomes a custom Codex tool
- Tool names prefixed with source slug to avoid conflicts

**Authentication:**
- Claude: API key (existing flow)
- Codex: CLI authentication (ChatGPT subscription required)
- Clear error messages guide users through setup

---

## Success Criteria

### Phase 1 Success
- ✅ All existing tests pass with provider abstraction
- ✅ No regressions in UI or functionality
- ✅ Headless tests validate Claude provider
- ✅ Event normalization handles all Claude event types

### Phase 2 Success
- ✅ CodexProvider passes integration tests
- ✅ Headless tests validate Codex provider
- ✅ MCP bridge successfully translates tools
- ✅ Side-by-side comparison shows both providers functional

### Phase 3 Success
- ✅ Provider selection works in UI
- ✅ Sessions store and load provider metadata
- ✅ Provider switching preserves history
- ✅ Settings display authentication status correctly

### Overall Success
- ✅ Zero breaking changes to existing sessions
- ✅ Both providers functional in production
- ✅ Comprehensive test coverage
- ✅ Documentation complete and accurate
