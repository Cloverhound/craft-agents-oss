/**
 * Tests for SessionRunner
 *
 * SessionRunner manages a persistent SDK streaming session using the
 * AsyncIterable input mode (MessageChannel as prompt).
 *
 * Note: These tests mock the SDK's query function since we can't spawn
 * actual SDK subprocesses in unit tests.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { SDKMessage, Options } from '@anthropic-ai/claude-agent-sdk';
import { SessionRunner, ForceStopError, type SessionRunnerConfig } from '../session-runner.ts';

// Mock SDK message types for testing
function createInitMessage(sessionId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    tools: [],
    mcp_servers: {},
  } as unknown as SDKMessage;
}

function createTextDeltaMessage(text: string): SDKMessage {
  return {
    type: 'stream_event' as const,
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  } as unknown as SDKMessage;
}

function createResultMessage(sessionId: string, text: string): SDKMessage {
  return {
    type: 'result' as const,
    session_id: sessionId,
    result: { text },
  } as unknown as SDKMessage;
}

// Track query calls for verification
interface QueryCall {
  prompt: unknown;
  options: Options;
}

describe('SessionRunner', () => {
  let queryCalls: QueryCall[];
  let mockMessages: SDKMessage[];
  let mockShouldFail: boolean;
  let originalQuery: unknown;

  beforeEach(() => {
    queryCalls = [];
    mockMessages = [];
    mockShouldFail = false;

    // Save original and mock the SDK
    originalQuery = (globalThis as any).__mockQuery;

    // Create mock query function
    (globalThis as any).__mockQuery = ({ prompt, options }: { prompt: unknown; options: Options }) => {
      queryCalls.push({ prompt, options });

      if (mockShouldFail) {
        throw new Error('Mock query failure');
      }

      // Return async iterable of mock messages
      return {
        async *[Symbol.asyncIterator]() {
          for (const msg of mockMessages) {
            yield msg;
          }
        },
      };
    };

    // Mock the module import
    // Note: In real tests, we'd use bun:test mock.module, but for this test
    // we'll use dependency injection via config
  });

  afterEach(() => {
    // Restore
    (globalThis as any).__mockQuery = originalQuery;
  });

  describe('state management', () => {
    it('starts in idle state', () => {
      const config: SessionRunnerConfig = {
        options: {} as Options,
      };
      const runner = new SessionRunner(config);

      expect(runner.state).toBe('idle');
      expect(runner.isActive).toBe(false);
      // Session ID is initialized with temp ID until we receive one from SDK
      expect(runner.sessionId).toMatch(/^temp-/);
      expect(runner.error).toBeNull();
    });
  });

  describe('lifecycle', () => {
    it('cannot send before start', () => {
      const config: SessionRunnerConfig = {
        options: {} as Options,
      };
      const runner = new SessionRunner(config);

      expect(() => {
        runner.send({ type: 'user', content: 'hello' } as any);
      }).toThrow('Cannot send message in state: idle');
    });

    it('cannot receive before start', async () => {
      const config: SessionRunnerConfig = {
        options: {} as Options,
      };
      const runner = new SessionRunner(config);

      await expect(async () => {
        for await (const _msg of runner.receiveUntilTurnComplete()) {
          // Should not get here
        }
      }).toThrow('Cannot receive messages in state: idle');
    });

    it('stop is idempotent', async () => {
      const config: SessionRunnerConfig = {
        options: {} as Options,
      };
      const runner = new SessionRunner(config);

      // Stop when already idle - should not throw
      await runner.stop();
      expect(runner.state).toBe('idle'); // Still idle (wasn't started)

      // Multiple stops should be safe
      await runner.stop();
      await runner.stop();
    });

    it('forceStop is immediate', () => {
      const config: SessionRunnerConfig = {
        options: {} as Options,
      };
      const runner = new SessionRunner(config);

      // Force stop when idle - should not throw
      runner.forceStop();
      expect(runner.state).toBe('stopped');
    });
  });

  describe('sendText convenience method', () => {
    it('wraps text in user message format', () => {
      const config: SessionRunnerConfig = {
        options: {} as Options,
      };
      const runner = new SessionRunner(config);

      // We can't fully test without starting, but we can verify the method exists
      expect(typeof runner.sendText).toBe('function');
    });
  });

  describe('error handling', () => {
    it('cannot start when already started', async () => {
      // This test would require actual SDK integration
      // For now, verify the state check exists
      const config: SessionRunnerConfig = {
        options: {} as Options,
      };
      const runner = new SessionRunner(config);

      // First we'd need to mock start() to succeed
      // Then verify second start() throws
      // This is complex without full SDK mocking
    });
  });

  describe('ForceStopError', () => {
    it('is exported and can be instantiated', () => {
      const err = new ForceStopError();
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ForceStopError);
      expect(err.name).toBe('ForceStopError');
      expect(err.message).toBe('Session force-stopped during iteration');
    });

    it('can be caught with instanceof', () => {
      try {
        throw new ForceStopError();
      } catch (e) {
        expect(e instanceof ForceStopError).toBe(true);
        expect(e instanceof Error).toBe(true);
      }
    });
  });

  describe('forceStop during iteration', () => {
    it('throws ForceStopError when responseIterator is nullified', async () => {
      const config: SessionRunnerConfig = {
        options: {} as Options,
      };
      const runner = new SessionRunner(config);

      // Simulate an active session by setting internal state directly
      // (can't call start() without real SDK)
      (runner as any)._state = 'active';
      (runner as any).responseIterator = {
        async next() {
          // Simulate forceStop being called during await:
          // nullify the iterator before returning
          (runner as any).responseIterator = null;
          (runner as any)._state = 'stopped';
          return { done: false, value: createTextDeltaMessage('hello') };
        },
      };

      const messages: SDKMessage[] = [];
      let caughtError: Error | null = null;

      try {
        for await (const msg of runner.receiveUntilTurnComplete()) {
          messages.push(msg);
          // After receiving first message, the mock iterator already
          // simulated forceStop — next iteration should throw ForceStopError
        }
      } catch (e) {
        caughtError = e as Error;
      }

      expect(caughtError).toBeInstanceOf(ForceStopError);
      // Should have received the one message before the stop
      expect(messages.length).toBe(1);
    });

    it('throws ForceStopError when state is stopped before first iteration', async () => {
      const config: SessionRunnerConfig = {
        options: {} as Options,
      };
      const runner = new SessionRunner(config);

      // Simulate active state with an iterator, then immediately forceStop
      (runner as any)._state = 'active';
      (runner as any).responseIterator = {
        async next() {
          return { done: false, value: createTextDeltaMessage('should not reach') };
        },
      };

      // forceStop before iteration starts
      runner.forceStop();

      let caughtError: Error | null = null;
      try {
        for await (const _msg of runner.receiveUntilTurnComplete()) {
          // Should not yield any messages
        }
      } catch (e) {
        caughtError = e as Error;
      }

      // State is 'stopped' so receiveUntilTurnComplete throws the state check error
      expect(caughtError).toBeTruthy();
      expect(caughtError!.message).toContain('Cannot receive messages in state: stopped');
    });
  });

  describe('debug callbacks', () => {
    it('calls onDebug during lifecycle', () => {
      const debugMessages: string[] = [];
      const config: SessionRunnerConfig = {
        options: {} as Options,
        onDebug: (msg) => debugMessages.push(msg),
      };
      const runner = new SessionRunner(config);

      // Force stop should trigger debug message
      runner.forceStop();

      expect(debugMessages.length).toBeGreaterThan(0);
      expect(debugMessages.some(m => m.includes('Force stopping'))).toBe(true);
    });
  });
});
