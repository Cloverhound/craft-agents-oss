/**
 * Tests for session_reset_to_message event handling
 *
 * Covers the "Edit & Reset Conversation" feature:
 * - handleSessionResetToMessage handler (pure function)
 * - processEvent routing for session_reset_to_message
 * - Edge cases: empty messages, streaming state, field preservation
 */

import { describe, it, expect } from 'bun:test'
import { processEvent } from '../processor'
import { handleSessionResetToMessage } from '../handlers/session'
import type { SessionState, SessionResetToMessageEvent } from '../types'
import type { Session, Message } from '../../../shared/types'

// ============================================================================
// Test Helpers
// ============================================================================

function createMessage(overrides: Partial<Message> & { role: Message['role'] }): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content: 'test message',
    timestamp: Date.now(),
    ...overrides,
  }
}

function createSession(overrides?: Partial<Session>): Session {
  return {
    id: 'session-1',
    workspaceId: 'ws-1',
    workspaceName: 'Test Workspace',
    lastMessageAt: Date.now(),
    messages: [],
    isProcessing: false,
    ...overrides,
  }
}

function createSessionState(overrides?: Partial<SessionState>): SessionState {
  return {
    session: createSession(),
    streaming: null,
    ...overrides,
  }
}

function createResetEvent(overrides?: Partial<SessionResetToMessageEvent>): SessionResetToMessageEvent {
  return {
    type: 'session_reset_to_message',
    sessionId: 'session-1',
    messages: [],
    ...overrides,
  }
}

// ============================================================================
// handleSessionResetToMessage - Pure handler tests
// ============================================================================

describe('handleSessionResetToMessage', () => {
  describe('message replacement', () => {
    it('replaces session messages with event payload', () => {
      const originalMessages = [
        createMessage({ role: 'user', content: 'hello' }),
        createMessage({ role: 'assistant', content: 'hi there', sdkUuid: 'uuid-1' }),
        createMessage({ role: 'user', content: 'how are you' }),
        createMessage({ role: 'assistant', content: 'I am well' }),
      ]

      const truncatedMessages = [
        createMessage({ role: 'user', content: 'hello' }),
        createMessage({ role: 'assistant', content: 'hi there', sdkUuid: 'uuid-1' }),
      ]

      const state = createSessionState({
        session: createSession({ messages: originalMessages }),
      })

      const event = createResetEvent({ messages: truncatedMessages })
      const result = handleSessionResetToMessage(state, event)

      expect(result.state.session.messages).toHaveLength(2)
      expect(result.state.session.messages).toBe(truncatedMessages)
    })

    it('works with empty messages array', () => {
      const state = createSessionState({
        session: createSession({
          messages: [createMessage({ role: 'user', content: 'hello' })],
        }),
      })

      const event = createResetEvent({ messages: [] })
      const result = handleSessionResetToMessage(state, event)

      expect(result.state.session.messages).toHaveLength(0)
    })

    it('preserves sdkUuid on messages in payload', () => {
      const messagesWithUuid = [
        createMessage({ role: 'user', content: 'hello' }),
        createMessage({ role: 'assistant', content: 'hi', sdkUuid: 'sdk-uuid-abc' }),
      ]

      const state = createSessionState()
      const event = createResetEvent({ messages: messagesWithUuid })
      const result = handleSessionResetToMessage(state, event)

      expect(result.state.session.messages[1].sdkUuid).toBe('sdk-uuid-abc')
    })
  })

  describe('processing state', () => {
    it('sets isProcessing to true', () => {
      const state = createSessionState({
        session: createSession({ isProcessing: false }),
      })

      const event = createResetEvent()
      const result = handleSessionResetToMessage(state, event)

      expect(result.state.session.isProcessing).toBe(true)
    })

    it('keeps isProcessing true if already processing', () => {
      const state = createSessionState({
        session: createSession({ isProcessing: true }),
      })

      const event = createResetEvent()
      const result = handleSessionResetToMessage(state, event)

      expect(result.state.session.isProcessing).toBe(true)
    })
  })

  describe('streaming state', () => {
    it('clears streaming state when present', () => {
      const state = createSessionState({
        streaming: {
          content: 'partial response text...',
          turnId: 'turn-1',
        },
      })

      const event = createResetEvent()
      const result = handleSessionResetToMessage(state, event)

      expect(result.state.streaming).toBeNull()
    })

    it('leaves streaming null when already null', () => {
      const state = createSessionState({ streaming: null })

      const event = createResetEvent()
      const result = handleSessionResetToMessage(state, event)

      expect(result.state.streaming).toBeNull()
    })

    it('clears streaming with parentToolUseId', () => {
      const state = createSessionState({
        streaming: {
          content: 'subagent output',
          turnId: 'turn-2',
          parentToolUseId: 'tool-use-1',
        },
      })

      const event = createResetEvent()
      const result = handleSessionResetToMessage(state, event)

      expect(result.state.streaming).toBeNull()
    })
  })

  describe('session field preservation', () => {
    it('preserves session ID', () => {
      const state = createSessionState({
        session: createSession({ id: 'my-session-id' }),
      })

      const event = createResetEvent()
      const result = handleSessionResetToMessage(state, event)

      expect(result.state.session.id).toBe('my-session-id')
    })

    it('preserves workspace info', () => {
      const state = createSessionState({
        session: createSession({
          workspaceId: 'ws-42',
          workspaceName: 'Production',
        }),
      })

      const event = createResetEvent()
      const result = handleSessionResetToMessage(state, event)

      expect(result.state.session.workspaceId).toBe('ws-42')
      expect(result.state.session.workspaceName).toBe('Production')
    })

    it('preserves session name', () => {
      const state = createSessionState({
        session: createSession({ name: 'My Chat Session' }),
      })

      const event = createResetEvent()
      const result = handleSessionResetToMessage(state, event)

      expect(result.state.session.name).toBe('My Chat Session')
    })

    it('preserves shared URL', () => {
      const state = createSessionState({
        session: createSession({
          sharedUrl: 'https://viewer.example.com/share/abc',
          sharedId: 'share-abc',
        }),
      })

      const event = createResetEvent()
      const result = handleSessionResetToMessage(state, event)

      expect(result.state.session.sharedUrl).toBe('https://viewer.example.com/share/abc')
      expect(result.state.session.sharedId).toBe('share-abc')
    })

    it('preserves permission mode', () => {
      const state = createSessionState({
        session: createSession({ permissionMode: 'execute' }),
      })

      const event = createResetEvent()
      const result = handleSessionResetToMessage(state, event)

      expect(result.state.session.permissionMode).toBe('execute')
    })

    it('preserves labels and flags', () => {
      const state = createSessionState({
        session: createSession({
          isFlagged: true,
          labels: ['bug', 'priority::high'],
        }),
      })

      const event = createResetEvent()
      const result = handleSessionResetToMessage(state, event)

      expect(result.state.session.isFlagged).toBe(true)
      expect(result.state.session.labels).toEqual(['bug', 'priority::high'])
    })

    it('preserves token usage (will be zeroed by main process separately)', () => {
      const tokenUsage = {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        contextTokens: 2000,
        costUsd: 0.05,
      }
      const state = createSessionState({
        session: createSession({ tokenUsage }),
      })

      const event = createResetEvent()
      const result = handleSessionResetToMessage(state, event)

      // Handler preserves tokenUsage; main process zeros it before emitting
      expect(result.state.session.tokenUsage).toEqual(tokenUsage)
    })

    it('preserves enabled source slugs', () => {
      const state = createSessionState({
        session: createSession({
          enabledSourceSlugs: ['github', 'linear'],
        }),
      })

      const event = createResetEvent()
      const result = handleSessionResetToMessage(state, event)

      expect(result.state.session.enabledSourceSlugs).toEqual(['github', 'linear'])
    })
  })

  describe('side effects', () => {
    it('emits no side effects', () => {
      const state = createSessionState()
      const event = createResetEvent()
      const result = handleSessionResetToMessage(state, event)

      expect(result.effects).toHaveLength(0)
    })
  })

  describe('immutability', () => {
    it('returns new session reference', () => {
      const originalSession = createSession()
      const state = createSessionState({ session: originalSession })
      const event = createResetEvent()

      const result = handleSessionResetToMessage(state, event)

      expect(result.state.session).not.toBe(originalSession)
    })

    it('does not mutate original state', () => {
      const originalMessages = [
        createMessage({ role: 'user', content: 'original' }),
      ]
      const state = createSessionState({
        session: createSession({ messages: originalMessages }),
      })

      const event = createResetEvent({
        messages: [createMessage({ role: 'user', content: 'truncated' })],
      })

      handleSessionResetToMessage(state, event)

      // Original state should be unchanged
      expect(state.session.messages).toHaveLength(1)
      expect(state.session.messages[0].content).toBe('original')
      expect(state.session.isProcessing).toBe(false)
    })
  })
})

// ============================================================================
// processEvent routing - Integration tests
// ============================================================================

describe('processEvent with session_reset_to_message', () => {
  it('routes to handleSessionResetToMessage handler', () => {
    const truncatedMessages = [
      createMessage({ role: 'user', content: 'hello' }),
      createMessage({ role: 'assistant', content: 'hi', sdkUuid: 'uuid-1' }),
    ]

    const state = createSessionState({
      session: createSession({
        messages: [
          ...truncatedMessages,
          createMessage({ role: 'user', content: 'deleted message' }),
          createMessage({ role: 'assistant', content: 'deleted response' }),
        ],
      }),
    })

    const event = createResetEvent({ messages: truncatedMessages })
    const result = processEvent(state, event)

    expect(result.state.session.messages).toHaveLength(2)
    expect(result.state.session.isProcessing).toBe(true)
    expect(result.state.streaming).toBeNull()
    expect(result.effects).toHaveLength(0)
  })

  it('clears active streaming during reset', () => {
    const state = createSessionState({
      session: createSession({
        isProcessing: true,
        messages: [
          createMessage({ role: 'user', content: 'hello' }),
          createMessage({ role: 'assistant', content: 'partial...', isStreaming: true }),
        ],
      }),
      streaming: { content: 'partial...', turnId: 'turn-1' },
    })

    const truncated = [createMessage({ role: 'user', content: 'hello' })]
    const result = processEvent(state, createResetEvent({ messages: truncated }))

    expect(result.state.streaming).toBeNull()
    expect(result.state.session.messages).toHaveLength(1)
  })
})

// ============================================================================
// Realistic scenario tests
// ============================================================================

describe('edit & reset scenario', () => {
  it('simulates typical edit flow: user edits message 3 in a 5-message conversation', () => {
    // Setup: 5-message conversation (user → assistant → user → assistant → user)
    const msg1 = createMessage({ role: 'user', id: 'msg-1', content: 'What is TypeScript?' })
    const msg2 = createMessage({ role: 'assistant', id: 'msg-2', content: 'TypeScript is...', sdkUuid: 'sdk-uuid-1' })
    const msg3 = createMessage({ role: 'user', id: 'msg-3', content: 'Tell me more' })
    const msg4 = createMessage({ role: 'assistant', id: 'msg-4', content: 'Sure, TypeScript also...', sdkUuid: 'sdk-uuid-2' })
    const msg5 = createMessage({ role: 'user', id: 'msg-5', content: 'Thanks' })

    const state = createSessionState({
      session: createSession({
        name: 'TypeScript Chat',
        messages: [msg1, msg2, msg3, msg4, msg5],
        isProcessing: false,
      }),
    })

    // User edits msg3 ("Tell me more" → "What about generics?")
    // Main process truncates to [msg1, msg2] and re-sends
    const truncatedMessages = [msg1, msg2]
    const event = createResetEvent({ messages: truncatedMessages })
    const result = processEvent(state, event)

    // Messages truncated to just before the edited message
    expect(result.state.session.messages).toHaveLength(2)
    expect(result.state.session.messages[0].id).toBe('msg-1')
    expect(result.state.session.messages[1].id).toBe('msg-2')

    // Processing started (main process sends edited message after this event)
    expect(result.state.session.isProcessing).toBe(true)

    // Session metadata preserved
    expect(result.state.session.name).toBe('TypeScript Chat')

    // No side effects
    expect(result.effects).toHaveLength(0)
  })

  it('simulates edit of the very first user message (truncates to empty)', () => {
    // When editing the first user message, there's no preceding assistant with sdkUuid.
    // The main process would return false (can't reset). But if it somehow succeeds
    // (e.g., first assistant message has sdkUuid), the truncated array would be empty.
    const state = createSessionState({
      session: createSession({
        messages: [
          createMessage({ role: 'user', content: 'Original first message' }),
          createMessage({ role: 'assistant', content: 'Response', sdkUuid: 'uuid-1' }),
        ],
      }),
    })

    const result = processEvent(state, createResetEvent({ messages: [] }))

    expect(result.state.session.messages).toHaveLength(0)
    expect(result.state.session.isProcessing).toBe(true)
  })

  it('handles reset during active streaming (interrupted response)', () => {
    const state = createSessionState({
      session: createSession({
        isProcessing: true,
        messages: [
          createMessage({ role: 'user', content: 'hello' }),
          createMessage({ role: 'assistant', content: 'I am currently typing...', isStreaming: true }),
        ],
      }),
      streaming: {
        content: 'I am currently typing...',
        turnId: 'turn-active',
      },
    })

    const truncated = [createMessage({ role: 'user', content: 'hello' })]
    const result = processEvent(state, createResetEvent({ messages: truncated }))

    // Streaming cleared, messages replaced, processing set
    expect(result.state.streaming).toBeNull()
    expect(result.state.session.messages).toHaveLength(1)
    expect(result.state.session.isProcessing).toBe(true)
  })
})
