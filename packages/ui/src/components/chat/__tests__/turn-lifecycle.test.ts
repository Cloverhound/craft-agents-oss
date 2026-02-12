/**
 * Scenario tests for turn lifecycle transitions.
 *
 * These tests verify the turn phase transitions through realistic
 * message flow scenarios, ensuring the state machine correctly
 * handles all common use cases.
 */

import { describe, it, expect } from 'bun:test'
import { deriveTurnPhase, groupMessagesByTurn, type AssistantTurn } from '../turn-utils'
import type { Message } from '@craft-agent/core'

// ============================================================================
// Test Helpers
// ============================================================================

let messageIdCounter = 0
let turnIdCounter = 0

function resetCounters() {
  messageIdCounter = 0
  turnIdCounter = 0
}

function createUserMessage(content = 'Hello'): Message {
  return {
    id: `user-${++messageIdCounter}`,
    role: 'user',
    content,
    timestamp: Date.now() + messageIdCounter * 100,
  }
}

function createToolMessage(
  status: 'running' | 'completed',
  name = 'Read',
  turnId?: string
): Message {
  return {
    id: `tool-${++messageIdCounter}`,
    role: 'tool',
    content: status === 'completed' ? 'Tool result' : '',
    timestamp: Date.now() + messageIdCounter * 100,
    toolName: name,
    toolUseId: `tu-${messageIdCounter}`,
    toolStatus: status === 'completed' ? 'completed' : undefined,
    toolResult: status === 'completed' ? 'Tool result' : undefined,
    turnId: turnId || `turn-${turnIdCounter}`,
  }
}

function createAssistantMessage(
  isStreaming: boolean,
  isIntermediate = false,
  turnId?: string
): Message {
  return {
    id: `assistant-${++messageIdCounter}`,
    role: 'assistant',
    content: 'Response text',
    timestamp: Date.now() + messageIdCounter * 100,
    isStreaming,
    isIntermediate,
    turnId: turnId || `turn-${turnIdCounter}`,
  }
}

/** Update a message in the array (simulating streaming updates) */
function updateMessage(
  messages: Message[],
  id: string,
  updates: Partial<Message>
): Message[] {
  return messages.map(m => (m.id === id ? { ...m, ...updates } : m))
}

/** Get the last assistant turn from grouped turns */
function getLastAssistantTurn(turns: ReturnType<typeof groupMessagesByTurn>): AssistantTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.type === 'assistant') {
      return turns[i] as AssistantTurn
    }
  }
  return undefined
}

// ============================================================================
// Scenario Tests
// ============================================================================

describe('turn lifecycle scenarios', () => {
  describe('simple response flow', () => {
    it('pending → streaming → complete (no tools)', () => {
      resetCounters()

      // 1. User message
      let messages: Message[] = [createUserMessage()]
      let turns = groupMessagesByTurn(messages)
      // No assistant turn yet
      expect(getLastAssistantTurn(turns)).toBeUndefined()

      // 2. Response starts streaming
      messages = [...messages, createAssistantMessage(true)]
      turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('streaming')

      // 3. Response completes
      messages = updateMessage(messages, 'assistant-2', { isStreaming: false })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('complete')
    })
  })

  describe('single tool flow', () => {
    it('pending → tool_active → awaiting → streaming → complete', () => {
      resetCounters()
      turnIdCounter++

      // 1. User message
      let messages: Message[] = [createUserMessage()]

      // 2. Tool starts running
      messages = [...messages, createToolMessage('running')]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 3. Tool completes - THIS IS THE GAP
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: 'File contents...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')

      // 4. Response starts streaming
      messages = [...messages, createAssistantMessage(true)]
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('streaming')

      // 5. Response completes
      messages = updateMessage(messages, 'assistant-3', { isStreaming: false })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('complete')
    })
  })

  describe('multi-tool flow', () => {
    it('tool_active → awaiting → tool_active → awaiting → streaming → complete', () => {
      resetCounters()
      turnIdCounter++

      // 1. First tool starts
      let messages: Message[] = [
        createUserMessage(),
        createToolMessage('running', 'Read'),
      ]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 2. First tool completes - GAP
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: 'File contents...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')

      // 3. Second tool starts
      messages = [...messages, createToolMessage('running', 'Grep')]
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 4. Second tool completes - GAP
      messages = updateMessage(messages, 'tool-3', {
        toolStatus: 'completed',
        toolResult: 'Search results...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')

      // 5. Response starts
      messages = [...messages, createAssistantMessage(true)]
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('streaming')

      // 6. Response completes
      messages = updateMessage(messages, 'assistant-4', { isStreaming: false })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('complete')
    })
  })

  describe('parallel tools flow', () => {
    it('handles multiple tools running in parallel', () => {
      resetCounters()
      turnIdCounter++

      // 1. Multiple tools start
      let messages: Message[] = [
        createUserMessage(),
        createToolMessage('running', 'Read'),
        createToolMessage('running', 'Grep'),
      ]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 2. First tool completes (second still running)
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: 'File contents...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active') // Still running

      // 3. Second tool completes - GAP
      messages = updateMessage(messages, 'tool-3', {
        toolStatus: 'completed',
        toolResult: 'Search results...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')
    })
  })

  describe('tool with error', () => {
    it('error transitions to awaiting (not stuck in tool_active)', () => {
      resetCounters()
      turnIdCounter++

      // 1. Tool starts
      let messages: Message[] = [
        createUserMessage(),
        createToolMessage('running', 'Read'),
      ]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 2. Tool errors
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: undefined,
        isError: true,
        content: 'File not found',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')
    })
  })

  describe('interruption', () => {
    it('user message during tool_active marks turn complete', () => {
      resetCounters()
      turnIdCounter++

      // 1. Tool running
      let messages: Message[] = [
        createUserMessage('First question'),
        createToolMessage('running', 'Read'),
      ]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 2. User interrupts with new message
      messages = [...messages, createUserMessage('Cancel that')]
      turns = groupMessagesByTurn(messages)
      // First assistant turn should now be complete (interrupted)
      const firstAssistantTurn = turns.find(t => t.type === 'assistant') as AssistantTurn
      expect(firstAssistantTurn.isComplete).toBe(true)
      expect(deriveTurnPhase(firstAssistantTurn)).toBe('complete')
    })
  })

  describe('intermediate text', () => {
    it('intermediate text during tool sequence stays in awaiting', () => {
      resetCounters()
      turnIdCounter++

      // 1. Tool completes
      let messages: Message[] = [
        createUserMessage(),
        createToolMessage('running', 'Read'),
      ]
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: 'File contents...',
      })
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')

      // 2. Intermediate text arrives (thinking out loud)
      messages = [...messages, createAssistantMessage(false, true)]
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      // Still awaiting because intermediate text is not the final response
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')
    })
  })
})

// ============================================================================
// Regression: "Upside Down Turn" Bug
// ============================================================================

describe('upside down turn regression', () => {
  it('response with earlier timestamp than tools stays in same turn', () => {
    // Regression: If the response message has an earlier timestamp than tool
    // messages (possible when text_delta fires before tool_start in the same
    // API round), the response must NOT split into a separate turn.
    resetCounters()
    const baseTime = Date.now()

    const messages: Message[] = [
      // User message
      { id: 'user-1', role: 'user', content: 'Hello', timestamp: baseTime },
      // Response with EARLIER timestamp (from text_delta before tools)
      {
        id: 'response-1', role: 'assistant', content: 'Here is the result',
        timestamp: baseTime + 100,
        isStreaming: false, isIntermediate: false,
      },
      // Tool with LATER timestamp (tool_start arrived after text_delta)
      {
        id: 'tool-1', role: 'tool', content: 'File contents',
        timestamp: baseTime + 200,
        toolName: 'Read', toolUseId: 'tu-1',
        toolStatus: 'completed', toolResult: 'File contents',
      },
      // Another tool with even later timestamp
      {
        id: 'tool-2', role: 'tool', content: 'Search results',
        timestamp: baseTime + 300,
        toolName: 'Grep', toolUseId: 'tu-2',
        toolStatus: 'completed', toolResult: 'Search results',
      },
    ]

    const turns = groupMessagesByTurn(messages)
    const assistantTurns = turns.filter(t => t.type === 'assistant') as AssistantTurn[]

    // Must be ONE assistant turn, not two
    expect(assistantTurns.length).toBe(1)
    // The turn must have both tools as activities AND the response
    expect(assistantTurns[0].activities.length).toBe(2)
    expect(assistantTurns[0].response).toBeDefined()
    expect(assistantTurns[0].response!.text).toBe('Here is the result')
    expect(assistantTurns[0].isComplete).toBe(true)
  })

  it('response between user messages does not split into separate turn from tools', () => {
    // Simulates the exact "upside down" scenario: response sorts before tools
    // due to timestamp, but all should be in one turn
    resetCounters()
    const baseTime = Date.now()

    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'Do something', timestamp: baseTime },
      // Intermediate text (from first API call, before tools)
      {
        id: 'intermediate-1', role: 'assistant', content: 'Let me check...',
        timestamp: baseTime + 50,
        isIntermediate: true, isPending: false, isStreaming: false,
      },
      // Tool from same API call
      {
        id: 'tool-1', role: 'tool', content: '',
        timestamp: baseTime + 100,
        toolName: 'Read', toolUseId: 'tu-1',
        toolStatus: 'completed', toolResult: 'Done',
      },
      // Final response (later API call) — timestamp is after tools
      {
        id: 'response-1', role: 'assistant', content: 'All done.',
        timestamp: baseTime + 500,
        isStreaming: false, isIntermediate: false,
      },
    ]

    const turns = groupMessagesByTurn(messages)
    const assistantTurns = turns.filter(t => t.type === 'assistant') as AssistantTurn[]

    expect(assistantTurns.length).toBe(1)
    // Activities: intermediate text + tool
    expect(assistantTurns[0].activities.length).toBe(2)
    expect(assistantTurns[0].response).toBeDefined()
    expect(assistantTurns[0].response!.text).toBe('All done.')
  })

  it('completed response does not flush turn (tools after response stay in same turn)', () => {
    // This tests the core fix: removing flush on final response
    resetCounters()
    const baseTime = Date.now()

    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'Hello', timestamp: baseTime },
      // Tool first
      {
        id: 'tool-1', role: 'tool', content: 'Done',
        timestamp: baseTime + 100,
        toolName: 'Write', toolUseId: 'tu-1',
        toolStatus: 'completed', toolResult: 'Done',
      },
      // Response arrives (non-streaming, non-intermediate)
      {
        id: 'response-1', role: 'assistant', content: 'Created the file.',
        timestamp: baseTime + 200,
        isStreaming: false, isIntermediate: false,
      },
      // Another tool arrives AFTER response (timestamp ordering anomaly)
      {
        id: 'tool-2', role: 'tool', content: 'Verified',
        timestamp: baseTime + 300,
        toolName: 'Read', toolUseId: 'tu-2',
        toolStatus: 'completed', toolResult: 'Verified',
      },
    ]

    const turns = groupMessagesByTurn(messages)
    const assistantTurns = turns.filter(t => t.type === 'assistant') as AssistantTurn[]

    // All should be in ONE turn
    expect(assistantTurns.length).toBe(1)
    expect(assistantTurns[0].activities.length).toBe(2)
    expect(assistantTurns[0].response).toBeDefined()
    expect(assistantTurns[0].response!.text).toBe('Created the file.')
  })
})

describe('edge cases', () => {
  it('empty activities array returns pending', () => {
    resetCounters()

    const turn: AssistantTurn = {
      type: 'assistant',
      turnId: 'test',
      activities: [],
      isStreaming: false,
      isComplete: false,
      timestamp: Date.now(),
    }
    expect(deriveTurnPhase(turn)).toBe('pending')
  })

  it('isComplete true with empty activities returns complete', () => {
    const turn: AssistantTurn = {
      type: 'assistant',
      turnId: 'test',
      activities: [],
      isStreaming: false,
      isComplete: true,
      timestamp: Date.now(),
    }
    expect(deriveTurnPhase(turn)).toBe('complete')
  })

  it('response with isStreaming false but isComplete false returns complete (defensive)', () => {
    // A non-streaming response is the authoritative signal that the turn is done.
    // This prevents "Thinking..." from showing when the response card is already
    // visible (transient state where isComplete lags behind response arrival).
    const turn: AssistantTurn = {
      type: 'assistant',
      turnId: 'test',
      activities: [
        {
          id: 'act-1',
          type: 'tool',
          status: 'completed',
          timestamp: Date.now(),
        },
      ],
      response: {
        text: 'Done',
        isStreaming: false,
      },
      isStreaming: false,
      isComplete: false, // Not yet marked complete
      timestamp: Date.now(),
    }
    // Defensive: non-streaming response → complete, regardless of isComplete flag
    expect(deriveTurnPhase(turn)).toBe('complete')
  })
})
