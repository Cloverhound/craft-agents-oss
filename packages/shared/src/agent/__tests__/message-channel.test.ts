/**
 * Tests for MessageChannel
 *
 * MessageChannel provides an AsyncIterable interface with external push capability,
 * used to maintain persistent SDK sessions via streaming input mode.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { MessageChannel, type SDKUserMessage } from '../message-channel.ts';

describe('MessageChannel', () => {
  let channel: MessageChannel;

  beforeEach(() => {
    channel = new MessageChannel();
  });

  describe('basic operations', () => {
    it('starts with closed=false', () => {
      expect(channel.closed).toBe(false);
    });

    it('starts with pendingCount=0', () => {
      expect(channel.pendingCount).toBe(0);
    });

    it('push() increments pendingCount', () => {
      const msg: SDKUserMessage = { type: 'user', content: 'hello' } as unknown as SDKUserMessage;
      channel.push(msg);
      expect(channel.pendingCount).toBe(1);

      channel.push(msg);
      expect(channel.pendingCount).toBe(2);
    });

    it('close() sets closed=true', () => {
      channel.close();
      expect(channel.closed).toBe(true);
    });

    it('close() is idempotent', () => {
      channel.close();
      channel.close(); // Should not throw
      expect(channel.closed).toBe(true);
    });

    it('push() throws after close', () => {
      channel.close();
      const msg: SDKUserMessage = { type: 'user', content: 'hello' } as unknown as SDKUserMessage;
      expect(() => channel.push(msg)).toThrow('Cannot push to closed MessageChannel');
    });

    it('clear() removes all pending messages', () => {
      const msg: SDKUserMessage = { type: 'user', content: 'hello' } as unknown as SDKUserMessage;
      channel.push(msg);
      channel.push(msg);
      expect(channel.pendingCount).toBe(2);

      channel.clear();
      expect(channel.pendingCount).toBe(0);
    });
  });

  describe('iteration', () => {
    it('yields messages that were pushed before iteration', async () => {
      const msg1: SDKUserMessage = { type: 'user', content: 'first' } as unknown as SDKUserMessage;
      const msg2: SDKUserMessage = { type: 'user', content: 'second' } as unknown as SDKUserMessage;

      channel.push(msg1);
      channel.push(msg2);
      channel.close();

      const received: SDKUserMessage[] = [];
      for await (const msg of channel) {
        received.push(msg);
      }

      expect(received).toHaveLength(2);
      expect((received[0] as unknown as { content: string }).content).toBe('first');
      expect((received[1] as unknown as { content: string }).content).toBe('second');
    });

    it('yields messages pushed during iteration', async () => {
      const msg: SDKUserMessage = { type: 'user', content: 'hello' } as unknown as SDKUserMessage;

      // Start iteration, push, then close
      const iterator = channel[Symbol.asyncIterator]();

      // Push asynchronously
      setTimeout(() => {
        channel.push(msg);
        channel.close();
      }, 10);

      const result = await iterator.next();
      expect(result.done).toBe(false);
      expect((result.value as { content: string }).content).toBe('hello');

      const end = await iterator.next();
      expect(end.done).toBe(true);
    });

    it('exits iteration when closed with no pending messages', async () => {
      // Close immediately with no messages
      setTimeout(() => channel.close(), 10);

      const received: SDKUserMessage[] = [];
      for await (const msg of channel) {
        received.push(msg);
      }

      expect(received).toHaveLength(0);
    });

    it('drains remaining messages after close', async () => {
      const msg1: SDKUserMessage = { type: 'user', content: 'first' } as unknown as SDKUserMessage;
      const msg2: SDKUserMessage = { type: 'user', content: 'second' } as unknown as SDKUserMessage;

      channel.push(msg1);
      channel.push(msg2);
      channel.close(); // Close while messages are queued

      const received: SDKUserMessage[] = [];
      for await (const msg of channel) {
        received.push(msg);
      }

      // Should still get all messages that were queued
      expect(received).toHaveLength(2);
    });
  });

  describe('producer-consumer pattern', () => {
    it('supports interleaved push/consume', async () => {
      const results: string[] = [];

      // Consumer
      const consumePromise = (async () => {
        for await (const msg of channel) {
          results.push((msg as unknown as { content: string }).content);
        }
      })();

      // Producer - push messages with delays
      await new Promise(resolve => setTimeout(resolve, 5));
      channel.push({ type: 'user', content: 'a' } as unknown as SDKUserMessage);

      await new Promise(resolve => setTimeout(resolve, 5));
      channel.push({ type: 'user', content: 'b' } as unknown as SDKUserMessage);

      await new Promise(resolve => setTimeout(resolve, 5));
      channel.push({ type: 'user', content: 'c' } as unknown as SDKUserMessage);

      channel.close();

      await consumePromise;

      expect(results).toEqual(['a', 'b', 'c']);
    });

    it('handles rapid push followed by slow consume', async () => {
      // Push many messages quickly
      for (let i = 0; i < 100; i++) {
        channel.push({ type: 'user', content: `msg-${i}` } as unknown as SDKUserMessage);
      }
      channel.close();

      expect(channel.pendingCount).toBe(100);

      // Consume slowly
      let count = 0;
      for await (const _msg of channel) {
        count++;
      }

      expect(count).toBe(100);
    });
  });
});
