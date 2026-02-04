/**
 * SDK message fixtures for CraftAgent tests.
 *
 * These fixtures represent the messages that the SDK's query() function yields.
 * They are intentionally minimal - only the fields that CraftAgent actually uses.
 */

import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// ============================================================================
// Session IDs
// ============================================================================

export const TEST_SESSION_ID = 'test-session-12345';
export const TEST_SESSION_ID_2 = 'test-session-67890';

// ============================================================================
// System Init Message
// ============================================================================

export function createSystemInitMessage(sessionId: string = TEST_SESSION_ID): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    uuid: 'uuid-init',
    session_id: sessionId,
    apiKeySource: 'user',
    cwd: '/test/cwd',
    tools: ['Read', 'Write', 'Bash', 'Grep', 'Glob'],
    mcp_servers: [],
    model: 'claude-sonnet-4-5-20250929',
    permissionMode: 'default',
    slash_commands: ['compact', 'help'],
    output_style: 'normal',
  } as SDKMessage;
}

// ============================================================================
// Assistant Messages
// ============================================================================

export function createAssistantTextMessage(
  text: string,
  sessionId: string = TEST_SESSION_ID,
  uuid: string = 'uuid-assistant-1'
): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: sessionId,
    message: {
      id: uuid,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: 'claude-sonnet-4-5-20250929',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    parent_tool_use_id: null,
  } as SDKMessage;
}

export function createAssistantToolUseMessage(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string = 'toolu_123',
  sessionId: string = TEST_SESSION_ID
): SDKMessage {
  return {
    type: 'assistant',
    uuid: `uuid-tool-${toolUseId}`,
    session_id: sessionId,
    message: {
      id: `msg-tool-${toolUseId}`,
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: toolUseId, name: toolName, input: toolInput },
      ],
      model: 'claude-sonnet-4-5-20250929',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    parent_tool_use_id: null,
  } as SDKMessage;
}

// ============================================================================
// User Messages (tool results)
// ============================================================================

export function createUserToolResultMessage(
  toolUseId: string,
  content: string,
  isError: boolean = false,
  sessionId: string = TEST_SESSION_ID
): SDKMessage {
  return {
    type: 'user',
    uuid: `uuid-result-${toolUseId}`,
    session_id: sessionId,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ],
    },
    parent_tool_use_id: null,
  } as SDKMessage;
}

// ============================================================================
// Result Messages
// ============================================================================

export function createSuccessResultMessage(
  sessionId: string = TEST_SESSION_ID,
  result: string = 'Task completed successfully.'
): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    uuid: 'uuid-result',
    session_id: sessionId,
    duration_ms: 1500,
    duration_api_ms: 1200,
    is_error: false,
    num_turns: 1,
    result,
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {
      'claude-sonnet-4-5-20250929': {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.01,
        contextWindow: 200000,
      },
    },
    permission_denials: [],
  } as SDKMessage;
}

export function createErrorResultMessage(
  errors: string[],
  sessionId: string = TEST_SESSION_ID
): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    uuid: 'uuid-error-result',
    session_id: sessionId,
    duration_ms: 500,
    duration_api_ms: 300,
    is_error: true,
    num_turns: 1,
    total_cost_usd: 0.005,
    usage: {
      input_tokens: 50,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    errors,
  } as SDKMessage;
}

// ============================================================================
// Streaming Events (partial messages)
// ============================================================================

export function createStreamEventMessageStart(
  sessionId: string = TEST_SESSION_ID
): SDKMessage {
  return {
    type: 'stream_event',
    uuid: 'uuid-stream-start',
    session_id: sessionId,
    parent_tool_use_id: null,
    event: {
      type: 'message_start',
      message: {
        id: 'msg-stream-1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    },
  } as SDKMessage;
}

export function createStreamEventTextDelta(
  text: string,
  sessionId: string = TEST_SESSION_ID
): SDKMessage {
  return {
    type: 'stream_event',
    uuid: 'uuid-stream-delta',
    session_id: sessionId,
    parent_tool_use_id: null,
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text,
      },
    },
  } as SDKMessage;
}

export function createStreamEventMessageDelta(
  stopReason: string = 'end_turn',
  sessionId: string = TEST_SESSION_ID
): SDKMessage {
  return {
    type: 'stream_event',
    uuid: 'uuid-stream-message-delta',
    session_id: sessionId,
    parent_tool_use_id: null,
    event: {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: { output_tokens: 50 },
    },
  } as SDKMessage;
}

// ============================================================================
// Sequences (common message flows)
// ============================================================================

/**
 * Simple text response sequence: init → stream → assistant → result
 */
export function createSimpleTextResponseSequence(
  text: string,
  sessionId: string = TEST_SESSION_ID
): SDKMessage[] {
  return [
    createSystemInitMessage(sessionId),
    createStreamEventMessageStart(sessionId),
    createStreamEventTextDelta(text, sessionId),
    createStreamEventMessageDelta('end_turn', sessionId),
    createAssistantTextMessage(text, sessionId),
    createSuccessResultMessage(sessionId, text),
  ];
}

/**
 * Tool use sequence: init → tool_use → tool_result → text → result
 */
export function createToolUseSequence(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResult: string,
  finalText: string,
  sessionId: string = TEST_SESSION_ID
): SDKMessage[] {
  const toolUseId = `toolu_${Date.now()}`;
  return [
    createSystemInitMessage(sessionId),
    createAssistantToolUseMessage(toolName, toolInput, toolUseId, sessionId),
    createUserToolResultMessage(toolUseId, toolResult, false, sessionId),
    createAssistantTextMessage(finalText, sessionId),
    createSuccessResultMessage(sessionId, finalText),
  ];
}

/**
 * Empty response sequence (used for testing session resume failures)
 */
export function createEmptyResponseSequence(sessionId: string = TEST_SESSION_ID): SDKMessage[] {
  return [
    createSystemInitMessage(sessionId),
    createSuccessResultMessage(sessionId, ''),
  ];
}
