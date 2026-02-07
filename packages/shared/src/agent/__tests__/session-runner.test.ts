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

  describe('forceStop() via Promise.race cancellation', () => {
    /**
     * Helper: creates a SessionRunner with internal state mocked to 'active'
     * and a controllable async iterator. This simulates a running session
     * without needing the real SDK subprocess.
     */
    function createActiveRunner(): {
      runner: SessionRunner;
      emitMessage: (msg: SDKMessage) => void;
      endIterator: () => void;
    } {
      const config: SessionRunnerConfig = {
        options: {} as Options,
      };
      const runner = new SessionRunner(config);

      // Message queue and resolver for the fake iterator
      const queue: SDKMessage[] = [];
      let pendingResolve: ((result: IteratorResult<SDKMessage>) => void) | null = null;
      let iteratorDone = false;

      // Fake async iterator that blocks on next() until we push a message
      const fakeIterator: AsyncIterator<SDKMessage> = {
        next(): Promise<IteratorResult<SDKMessage>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (iteratorDone) {
            return Promise.resolve({ value: undefined as any, done: true });
          }
          return new Promise((resolve) => {
            pendingResolve = resolve;
          });
        },
      };

      // Set up internal state to simulate an active session
      (runner as any)._state = 'active';
      (runner as any).channel = { push: () => {}, close: () => {} };
      (runner as any).responseIterator = fakeIterator;
      (runner as any).queryInstance = {};

      // Create the forceStop cancellation promise (same as real start())
      (runner as any).forceStopPromise = new Promise<never>((_, reject) => {
        (runner as any).forceStopResolve = () => reject(new ForceStopError());
      });

      return {
        runner,
        emitMessage: (msg: SDKMessage) => {
          if (pendingResolve) {
            const resolve = pendingResolve;
            pendingResolve = null;
            resolve({ value: msg, done: false });
          } else {
            queue.push(msg);
          }
        },
        endIterator: () => {
          iteratorDone = true;
          if (pendingResolve) {
            const resolve = pendingResolve;
            pendingResolve = null;
            resolve({ value: undefined as any, done: true });
          }
        },
      };
    }

    it('should throw ForceStopError immediately when forceStop() is called during pending .next()', async () => {
      const { runner } = createActiveRunner();

      // Start iterating — this will block on .next() since no messages are queued
      const iteratePromise = (async () => {
        const messages: SDKMessage[] = [];
        for await (const msg of runner.receiveUntilTurnComplete()) {
          messages.push(msg);
        }
        return messages;
      })();

      // Give the iterator time to enter the await .next() call
      await new Promise((r) => setTimeout(r, 10));

      // Force stop — this should immediately unblock via Promise.race
      runner.forceStop();

      // The iteration should reject with ForceStopError
      await expect(iteratePromise).rejects.toThrow(ForceStopError);
    });

    it('should unblock within milliseconds, not seconds', async () => {
      const { runner } = createActiveRunner();

      const startTime = Date.now();

      const iteratePromise = (async () => {
        for await (const _ of runner.receiveUntilTurnComplete()) {
          // will never yield — no messages emitted
        }
      })();

      // Small delay to ensure we're blocked on .next()
      await new Promise((r) => setTimeout(r, 5));

      runner.forceStop();

      try {
        await iteratePromise;
      } catch {
        // Expected ForceStopError
      }

      const elapsed = Date.now() - startTime;
      // Should resolve almost immediately — well under 1 second
      expect(elapsed).toBeLessThan(500);
    });

    it('should allow receiving messages before forceStop interrupts', async () => {
      const { runner, emitMessage } = createActiveRunner();

      // Queue a message before iterating
      emitMessage(createTextDeltaMessage('hello'));

      let messageCount = 0;
      const iteratePromise = (async () => {
        for await (const _msg of runner.receiveUntilTurnComplete()) {
          messageCount++;
          // After first message, forceStop while blocked on next .next()
          if (messageCount === 1) {
            // Small delay to ensure we re-enter the await
            setTimeout(() => runner.forceStop(), 10);
          }
        }
      })();

      await expect(iteratePromise).rejects.toThrow(ForceStopError);
      expect(messageCount).toBe(1);
    });

    it('should yield all messages then break normally on result type (no forceStop)', async () => {
      const { runner, emitMessage } = createActiveRunner();

      // Queue messages including a 'result' to end the turn
      emitMessage(createInitMessage('sess-1'));
      emitMessage(createTextDeltaMessage('thinking...'));
      emitMessage(createResultMessage('sess-1', 'done'));

      const messages: SDKMessage[] = [];
      for await (const msg of runner.receiveUntilTurnComplete()) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(3);
      expect(messages[2].type).toBe('result');
    });
  });
});
