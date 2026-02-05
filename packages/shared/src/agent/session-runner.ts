/**
 * Session Runner for Persistent SDK Sessions
 *
 * Manages a persistent SDK subprocess connection using the streaming input mode.
 * Instead of spawning a new subprocess for each message (query-per-message),
 * this maintains a single subprocess that stays alive between messages.
 *
 * Benefits:
 * - Background bash tasks persist across messages
 * - Reduced subprocess spawn overhead
 * - Warm V8 JIT compilation
 * - Lower memory churn (no repeated history loading)
 *
 * @example
 * ```typescript
 * const runner = new SessionRunner(options);
 * await runner.start();
 *
 * // Send first message
 * runner.send({ type: 'user', content: 'Start a dev server in background' });
 * for await (const msg of runner.receiveUntilTurnComplete()) {
 *   // Process SDK messages...
 * }
 *
 * // Send second message - subprocess still alive, dev server still running
 * runner.send({ type: 'user', content: 'Now run the tests' });
 * for await (const msg of runner.receiveUntilTurnComplete()) {
 *   // Process SDK messages...
 * }
 *
 * // Cleanup
 * await runner.stop();
 * ```
 */

import { query, type Query, type SDKMessage, type Options } from '@anthropic-ai/claude-agent-sdk';
import { MessageChannel, type SDKUserMessage } from './message-channel.ts';

export interface SessionRunnerConfig {
  /**
   * SDK options to pass to query().
   */
  options: Options;

  /**
   * Initial session ID (for resume scenarios).
   * If not provided, a temporary ID will be used until we receive the real one.
   */
  sessionId?: string;

  /**
   * Called when the SDK subprocess exits unexpectedly.
   */
  onUnexpectedExit?: (error: Error) => void;

  /**
   * Called for debug logging.
   */
  onDebug?: (message: string) => void;
}

export type SessionRunnerState = 'idle' | 'starting' | 'active' | 'stopping' | 'stopped' | 'error';

/**
 * Manages a persistent SDK streaming session.
 */
export class SessionRunner {
  private channel: MessageChannel | null = null;
  private queryInstance: Query | null = null;
  private responseIterator: AsyncIterator<SDKMessage> | null = null;
  private _state: SessionRunnerState = 'idle';
  private _error: Error | null = null;
  private _sessionId: string | null = null;

  constructor(private config: SessionRunnerConfig) {
    // Initialize session ID from config (for resume scenarios) or generate a temp one
    this._sessionId = config.sessionId || `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  /**
   * Current state of the session runner.
   */
  get state(): SessionRunnerState {
    return this._state;
  }

  /**
   * Whether the session is active and ready to send/receive messages.
   */
  get isActive(): boolean {
    return this._state === 'active';
  }

  /**
   * The SDK session ID, captured from the first response.
   */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /**
   * Error that caused the session to enter error state.
   */
  get error(): Error | null {
    return this._error;
  }

  /**
   * Start the persistent session.
   * Creates the message channel and initiates the SDK query.
   *
   * @throws If session is already started or in error state
   */
  async start(): Promise<void> {
    if (this._state !== 'idle' && this._state !== 'stopped') {
      throw new Error(`Cannot start session in state: ${this._state}`);
    }

    this._state = 'starting';
    this._error = null;
    this.config.onDebug?.('[SessionRunner] Starting persistent session');

    try {
      // Create fresh message channel
      this.channel = new MessageChannel();

      // Start query with channel as the prompt (streaming input mode)
      this.queryInstance = query({
        prompt: this.channel,
        options: this.config.options,
      });

      // Get the async iterator for responses
      this.responseIterator = this.queryInstance[Symbol.asyncIterator]();

      this._state = 'active';
      this.config.onDebug?.('[SessionRunner] Session active');
    } catch (error) {
      this._state = 'error';
      this._error = error instanceof Error ? error : new Error(String(error));
      this.config.onDebug?.(`[SessionRunner] Failed to start: ${this._error.message}`);
      throw this._error;
    }
  }

  /**
   * Send a user message through the channel.
   * The message is queued and will be consumed by the SDK subprocess.
   *
   * @param message - The user message to send
   * @throws If session is not active
   */
  send(message: SDKUserMessage): void {
    if (this._state !== 'active') {
      throw new Error(`Cannot send message in state: ${this._state}`);
    }

    if (!this.channel) {
      throw new Error('Channel not initialized');
    }

    this.config.onDebug?.('[SessionRunner] Sending message through channel');
    this.channel.push(message);
  }

  /**
   * Send a simple text message.
   * Convenience method that wraps the text in the proper SDK message format.
   *
   * @param text - The text content to send
   */
  sendText(text: string): void {
    // SDK expects SDKUserMessage format with nested MessageParam
    const message: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: text,
      },
      parent_tool_use_id: null,
      session_id: this._sessionId!,
    };
    this.send(message);
  }

  /**
   * Receive SDK messages until the current turn is complete.
   * A turn is complete when a 'result' message is received.
   *
   * This is an async generator that yields each SDK message as it arrives.
   * Call this after send() to process the assistant's response.
   *
   * @yields SDK messages from the subprocess
   * @throws If session is not active or subprocess exits unexpectedly
   */
  async *receiveUntilTurnComplete(): AsyncGenerator<SDKMessage, void, undefined> {
    if (this._state !== 'active') {
      throw new Error(`Cannot receive messages in state: ${this._state}`);
    }

    if (!this.responseIterator) {
      throw new Error('Response iterator not initialized');
    }

    try {
      while (true) {
        const result = await this.responseIterator.next();

        if (result.done) {
          // Iterator exhausted - subprocess exited
          this.config.onDebug?.('[SessionRunner] Response iterator exhausted');
          this._state = 'stopped';
          this._error = new Error('SDK subprocess exited unexpectedly');
          this.config.onUnexpectedExit?.(this._error);
          throw this._error;
        }

        const message = result.value;

        // Capture session ID from first message
        if ('session_id' in message && message.session_id && !this._sessionId) {
          this._sessionId = message.session_id;
          this.config.onDebug?.(`[SessionRunner] Captured session ID: ${this._sessionId}`);
        }

        yield message;

        // Check for turn completion
        if (message.type === 'result') {
          this.config.onDebug?.('[SessionRunner] Turn complete (result message received)');
          break;
        }
      }
    } catch (error) {
      // Handle errors during iteration
      if (this._state === 'active') {
        this._state = 'error';
        this._error = error instanceof Error ? error : new Error(String(error));
        this.config.onDebug?.(`[SessionRunner] Error during receive: ${this._error.message}`);
      }
      throw error;
    }
  }

  /**
   * Stop the session gracefully.
   * Closes the message channel, allowing the subprocess to exit cleanly.
   */
  async stop(): Promise<void> {
    if (this._state === 'stopped' || this._state === 'idle') {
      return;
    }

    this.config.onDebug?.('[SessionRunner] Stopping session');
    this._state = 'stopping';

    // Close the channel to signal end of input
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }

    // Allow time for graceful shutdown
    // The SDK subprocess should exit when the input stream closes
    this.responseIterator = null;
    this.queryInstance = null;

    this._state = 'stopped';
    this.config.onDebug?.('[SessionRunner] Session stopped');
  }

  /**
   * Force stop the session immediately.
   * Used for abort scenarios where we can't wait for graceful shutdown.
   */
  forceStop(): void {
    this.config.onDebug?.('[SessionRunner] Force stopping session');

    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }

    this.responseIterator = null;
    this.queryInstance = null;
    this._state = 'stopped';
  }
}
