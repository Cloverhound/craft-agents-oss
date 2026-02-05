/**
 * Message Channel for Persistent SDK Sessions
 *
 * An AsyncIterable that allows external code to push messages into a stream.
 * Used to maintain a persistent SDK subprocess by passing this as the `prompt`
 * parameter to `query()`, enabling multiple user messages over a single connection.
 *
 * @example
 * ```typescript
 * const channel = new MessageChannel();
 *
 * // Start query with channel as prompt
 * const q = query({ prompt: channel, options });
 *
 * // Send messages through the channel
 * channel.push({ type: 'user', content: 'Hello' });
 *
 * // Process responses
 * for await (const message of q) {
 *   console.log(message);
 * }
 *
 * // Close when done
 * channel.close();
 * ```
 */

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// Re-export for convenience
export type { SDKUserMessage };

/**
 * AsyncIterable message channel with external push capability.
 *
 * Implements a producer-consumer pattern where:
 * - External code pushes messages via `push()`
 * - SDK consumes messages via async iteration
 * - Channel can be closed to signal end of stream
 */
export class MessageChannel implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private resolver: ((msg: SDKUserMessage | null) => void) | null = null;
  private _closed = false;

  /**
   * Whether the channel has been closed.
   */
  get closed(): boolean {
    return this._closed;
  }

  /**
   * Push a message into the channel.
   * If the consumer is waiting, delivers immediately.
   * Otherwise, queues for later consumption.
   *
   * @param message - The SDK user message to send
   * @throws If channel is already closed
   */
  push(message: SDKUserMessage): void {
    if (this._closed) {
      throw new Error('Cannot push to closed MessageChannel');
    }

    if (this.resolver) {
      // Consumer is waiting - deliver immediately
      const resolve = this.resolver;
      this.resolver = null;
      resolve(message);
    } else {
      // Queue for later
      this.queue.push(message);
    }
  }

  /**
   * Close the channel, signaling end of stream.
   * Any waiting consumer will receive null and exit iteration.
   * Subsequent push() calls will throw.
   */
  close(): void {
    if (this._closed) return;

    this._closed = true;

    // Signal any waiting consumer to exit
    if (this.resolver) {
      const resolve = this.resolver;
      this.resolver = null;
      resolve(null);
    }
  }

  /**
   * Number of messages currently queued.
   */
  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Clear any pending messages without closing the channel.
   */
  clear(): void {
    this.queue = [];
  }

  /**
   * Async iterator implementation.
   * Yields messages as they are pushed, blocking when queue is empty.
   * Exits when channel is closed.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this._closed) {
      if (this.queue.length > 0) {
        // Yield queued message
        yield this.queue.shift()!;
      } else {
        // Wait for next message or close signal
        const msg = await new Promise<SDKUserMessage | null>((resolve) => {
          this.resolver = resolve;
        });

        // null signals channel closed
        if (msg === null) {
          break;
        }

        yield msg;
      }
    }

    // Drain any remaining queued messages before exiting
    while (this.queue.length > 0) {
      yield this.queue.shift()!;
    }
  }
}
