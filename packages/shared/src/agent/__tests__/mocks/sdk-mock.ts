/**
 * Mock infrastructure for @anthropic-ai/claude-agent-sdk.
 *
 * This provides a controllable mock of the SDK's query() function that can be
 * configured to yield specific message sequences for testing CraftAgent behavior.
 *
 * Usage:
 *   const mockQuery = createMockQuery();
 *   mockQuery.setMessages([...sdkMessages]);
 *   // CraftAgent will receive these messages when it calls query()
 */

import { mock } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// ============================================================================
// Types
// ============================================================================

export interface MockQueryOptions {
  /** Delay in ms between yielding messages (simulates network latency) */
  messageDelay?: number;
  /** If true, throw this error instead of yielding messages */
  throwError?: Error;
  /** Callback when query() is called - useful for capturing options */
  onQueryCalled?: (args: { prompt: unknown; options: unknown }) => void;
}

export interface MockQueryInstance {
  /** Set the messages that will be yielded */
  setMessages: (messages: SDKMessage[]) => void;
  /** Set options for behavior control */
  setOptions: (options: MockQueryOptions) => void;
  /** Clear all options (including throwError) */
  clearOptions: () => void;
  /** Get the last options passed to query() */
  getLastCallOptions: () => unknown | undefined;
  /** Get all calls to query() */
  getAllCalls: () => Array<{ prompt: unknown; options: unknown }>;
  /** Reset call history */
  resetCalls: () => void;
  /** Full reset - calls, messages, and options */
  reset: () => void;
  /** The mock function itself */
  queryFn: ReturnType<typeof mock>;
}

// ============================================================================
// Mock Query Implementation
// ============================================================================

/**
 * Creates a mock query function that yields configured messages.
 *
 * The returned mock can be configured with setMessages() and setOptions()
 * to control what messages are yielded and how.
 */
export function createMockQuery(): MockQueryInstance {
  let messages: SDKMessage[] = [];
  let options: MockQueryOptions = {};
  const calls: Array<{ prompt: unknown; options: unknown }> = [];

  // Create the mock async generator
  async function* mockQueryGenerator(args: { prompt: unknown; options: unknown }) {
    calls.push(args);
    options.onQueryCalled?.(args);

    if (options.throwError) {
      throw options.throwError;
    }

    for (const message of messages) {
      if (options.messageDelay) {
        await new Promise(resolve => setTimeout(resolve, options.messageDelay));
      }
      yield message;
    }
  }

  // Create the mock function that returns the generator
  const queryFn = mock((args: { prompt: unknown; options: unknown }) => {
    const generator = mockQueryGenerator(args);
    // Add Query interface methods (stubs for now)
    return Object.assign(generator, {
      interrupt: mock(() => Promise.resolve()),
      rewindFiles: mock(() => Promise.resolve()),
      setPermissionMode: mock(() => Promise.resolve()),
      setModel: mock(() => Promise.resolve()),
      setMaxThinkingTokens: mock(() => Promise.resolve()),
      supportedCommands: mock(() => Promise.resolve([])),
      supportedModels: mock(() => Promise.resolve([])),
      mcpServerStatus: mock(() => Promise.resolve([])),
      accountInfo: mock(() => Promise.resolve({})),
    });
  });

  return {
    setMessages: (newMessages: SDKMessage[]) => {
      messages = newMessages;
    },
    setOptions: (newOptions: MockQueryOptions) => {
      options = { ...options, ...newOptions };
    },
    /** Clear all options (including throwError) */
    clearOptions: () => {
      options = {};
    },
    getLastCallOptions: () => calls[calls.length - 1]?.options,
    getAllCalls: () => [...calls],
    resetCalls: () => {
      calls.length = 0;
    },
    /** Full reset - calls, messages, and options */
    reset: () => {
      calls.length = 0;
      messages = [];
      options = {};
    },
    queryFn,
  };
}

// ============================================================================
// Mock AbortError
// ============================================================================

export class MockAbortError extends Error {
  constructor(message: string = 'Aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

// ============================================================================
// Helpers for common test scenarios
// ============================================================================

/**
 * Creates a mock query that simulates an abort scenario.
 * The abort happens after yielding the specified number of messages.
 */
export function createAbortingMockQuery(
  messages: SDKMessage[],
  abortAfterCount: number
): MockQueryInstance {
  const mockQuery = createMockQuery();

  // Override setMessages to inject abort behavior
  const slicedMessages = messages.slice(0, abortAfterCount);
  mockQuery.setMessages(slicedMessages);
  mockQuery.setOptions({
    onQueryCalled: () => {
      // The abort will be triggered externally via AbortController
    },
  });

  return mockQuery;
}

/**
 * Creates a mock query that simulates a process error (non-zero exit code).
 * This is used to test error recovery scenarios.
 */
export function createErrorMockQuery(errorMessage: string): MockQueryInstance {
  const mockQuery = createMockQuery();
  mockQuery.setOptions({
    throwError: new Error(errorMessage),
  });
  return mockQuery;
}
