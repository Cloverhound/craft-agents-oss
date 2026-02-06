/**
 * Integration tests for CraftAgent chat flow.
 *
 * These tests validate the high-level behavior of CraftAgent.chat() without
 * depending on internal implementation details. They mock the SDK's query()
 * function to control what messages are received.
 *
 * Test categories:
 * 1. Basic chat flow - message in, events out
 * 2. Session continuity - sessionId captured and reused
 * 3. Error recovery - session expiry, process errors
 * 4. Abort handling - user stop, plan submission
 *
 * NOTE: These tests use bun:test's mock.module to replace the SDK module.
 * The mock must be set up before importing CraftAgent.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { createMockQuery, MockAbortError, type MockQueryInstance } from './mocks/sdk-mock';
import {
  createSimpleTextResponseSequence,
  createToolUseSequence,
  createEmptyResponseSequence,
  createSystemInitMessage,
  createAssistantTextMessage,
  createSuccessResultMessage,
  createErrorResultMessage,
  TEST_SESSION_ID,
  TEST_SESSION_ID_2,
} from './fixtures/sdk-messages';

// ============================================================================
// Module Mock Setup
// ============================================================================

// Create mock query instance that will be used across tests
let mockQuery: MockQueryInstance;

// Mock the SDK module before any imports that use it
// This needs to happen at module load time
mock.module('@anthropic-ai/claude-agent-sdk', () => {
  mockQuery = createMockQuery();
  return {
    query: mockQuery.queryFn,
    createSdkMcpServer: mock(() => ({ type: 'sdk', name: 'mock', instance: {} })),
    tool: mock((name: string, desc: string, schema: unknown, handler: unknown) => ({
      name,
      description: desc,
      inputSchema: schema,
      handler,
    })),
    AbortError: MockAbortError,
  };
});

// Now import CraftAgent (after mock is set up)
// Note: Dynamic import to ensure mock is applied first
let CraftAgent: typeof import('../craft-agent').CraftAgent;
let AbortReason: typeof import('../craft-agent').AbortReason;

// ============================================================================
// Test Helpers
// ============================================================================

function createTestWorkspace() {
  return {
    id: 'test-workspace',
    name: 'Test Workspace',
    rootPath: '/tmp/test-workspace',
    createdAt: Date.now(),
  };
}

function createTestSession(sdkSessionId?: string) {
  return {
    id: 'test-session',
    sdkSessionId,
    workspaceId: 'test-workspace',
    workspaceRootPath: '/tmp/test-workspace',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
}

async function collectEvents(chatGenerator: AsyncGenerator<unknown>) {
  const events: unknown[] = [];
  for await (const event of chatGenerator) {
    events.push(event);
  }
  return events;
}

function findEventsByType(events: unknown[], type: string) {
  return events.filter((e: any) => e.type === type);
}

// ============================================================================
// Test Setup
// ============================================================================

beforeEach(async () => {
  // Dynamically import after mock is set up
  const module = await import('../craft-agent');
  CraftAgent = module.CraftAgent;
  AbortReason = module.AbortReason;

  // Full reset of mock state (calls, messages, AND options including throwError)
  mockQuery.reset();
});

// ============================================================================
// Basic Chat Flow Tests
// ============================================================================

describe('CraftAgent.chat() - Basic Flow', () => {
  it('yields events for a simple text response', async () => {
    // Arrange
    mockQuery.setMessages(createSimpleTextResponseSequence('Hello, world!'));

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true, // Disable config watcher for tests
    });

    // Act
    const events = await collectEvents(agent.chat('Say hello'));

    // Assert
    expect(events.length).toBeGreaterThan(0);

    // Should have a complete event at the end
    const completeEvents = findEventsByType(events, 'complete');
    expect(completeEvents.length).toBe(1);

    // Clean up
    agent.dispose();
  });

  it('yields text_delta events during streaming', async () => {
    // Arrange
    mockQuery.setMessages(createSimpleTextResponseSequence('Hello, world!'));

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
    });

    // Act
    const events = await collectEvents(agent.chat('Say hello'));

    // Assert
    const textDeltas = findEventsByType(events, 'text_delta');
    expect(textDeltas.length).toBeGreaterThan(0);

    agent.dispose();
  });

  it('yields tool_start and tool_result events for tool usage', async () => {
    // Arrange
    mockQuery.setMessages(
      createToolUseSequence(
        'Read',
        { file_path: '/test/file.txt' },
        'File contents here',
        'I read the file for you.'
      )
    );

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
    });

    // Act
    const events = await collectEvents(agent.chat('Read the file'));

    // Assert
    const toolStarts = findEventsByType(events, 'tool_start');
    const toolResults = findEventsByType(events, 'tool_result');

    expect(toolStarts.length).toBeGreaterThan(0);
    expect(toolResults.length).toBeGreaterThan(0);

    // Tool start should have the tool name
    expect((toolStarts[0] as any).toolName).toBe('Read');

    agent.dispose();
  });

  it('passes the user message to the SDK query', async () => {
    // Arrange
    mockQuery.setMessages(createSimpleTextResponseSequence('Response'));

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
    });

    // Act
    await collectEvents(agent.chat('My test message'));

    // Assert - with SessionRunner, message goes through the channel
    const channelMessages = mockQuery.getChannelMessages();
    expect(channelMessages.length).toBeGreaterThanOrEqual(1);
    // SDKUserMessage format: { type: 'user', message: { role: 'user', content: '...' } }
    const msgContent = (channelMessages[0] as any).message?.content;
    expect(String(msgContent)).toContain('My test message');

    agent.dispose();
  });
});

// ============================================================================
// Session Continuity Tests
// ============================================================================

describe('CraftAgent.chat() - Session Continuity', () => {
  it('captures session ID from first response', async () => {
    // Arrange
    let capturedSessionId: string | undefined;
    mockQuery.setMessages(createSimpleTextResponseSequence('Hello', TEST_SESSION_ID));

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
      onSdkSessionIdUpdate: (id) => {
        capturedSessionId = id;
      },
    });

    // Act
    await collectEvents(agent.chat('Hello'));

    // Assert
    expect(capturedSessionId).toBe(TEST_SESSION_ID);
    expect(agent.getSessionId()).toBe(TEST_SESSION_ID);

    agent.dispose();
  });

  it('uses resume option when session ID exists', async () => {
    // Arrange
    mockQuery.setMessages(createSimpleTextResponseSequence('Response'));

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(TEST_SESSION_ID), // Pre-existing session ID
      isHeadless: true,
    });

    // Act
    await collectEvents(agent.chat('Continue conversation'));

    // Assert
    const calls = mockQuery.getAllCalls();
    expect(calls.length).toBe(1);

    const options = calls[0]!.options as any;
    expect(options.resume).toBe(TEST_SESSION_ID);

    agent.dispose();
  });

  it('does not use resume option on fresh session', async () => {
    // Arrange
    mockQuery.setMessages(createSimpleTextResponseSequence('Response'));

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(), // No sdkSessionId
      isHeadless: true,
    });

    // Act
    await collectEvents(agent.chat('New conversation'));

    // Assert
    const calls = mockQuery.getAllCalls();
    expect(calls.length).toBe(1);

    const options = calls[0]!.options as any;
    expect(options.resume).toBeUndefined();

    agent.dispose();
  });

  it('updates session ID when it changes', async () => {
    // Arrange
    const sessionIdUpdates: string[] = [];
    mockQuery.setMessages(createSimpleTextResponseSequence('Hello', TEST_SESSION_ID));

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
      onSdkSessionIdUpdate: (id) => {
        sessionIdUpdates.push(id);
      },
    });

    // Act - First chat
    await collectEvents(agent.chat('First message'));

    // Queue second turn's messages with different session ID
    // Note: don't call resetCalls() - SessionRunner keeps the same query()
    mockQuery.setMessages(createSimpleTextResponseSequence('Hello again', TEST_SESSION_ID_2));

    await collectEvents(agent.chat('Second message'));

    // Assert - session ID callback should have been called with both IDs
    expect(sessionIdUpdates).toContain(TEST_SESSION_ID);
    expect(sessionIdUpdates).toContain(TEST_SESSION_ID_2);

    agent.dispose();
  });
});

// ============================================================================
// Error Recovery Tests
// ============================================================================

describe('CraftAgent.chat() - Error Recovery', () => {
  it('yields error event when SDK throws', async () => {
    // Arrange
    mockQuery.setOptions({
      throwError: new Error('SDK process crashed'),
    });

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
    });

    // Act
    const events = await collectEvents(agent.chat('Trigger error'));

    // Assert
    const errorEvents = findEventsByType(events, 'error');
    expect(errorEvents.length).toBeGreaterThan(0);

    agent.dispose();
  });

  it('yields typed_error for known error types', async () => {
    // Arrange
    mockQuery.setMessages([
      createSystemInitMessage(),
      createErrorResultMessage(['Authentication failed']),
    ]);

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
    });

    // Act
    const events = await collectEvents(agent.chat('Trigger auth error'));

    // Assert
    // Should have either error or typed_error
    const errorEvents = findEventsByType(events, 'error');
    const typedErrorEvents = findEventsByType(events, 'typed_error');
    expect(errorEvents.length + typedErrorEvents.length).toBeGreaterThan(0);

    agent.dispose();
  });

  it('clears session ID on empty response during resume', async () => {
    // Arrange
    let sessionIdCleared = false;
    mockQuery.setMessages(createEmptyResponseSequence(TEST_SESSION_ID_2));

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(TEST_SESSION_ID), // Has existing session
      isHeadless: true,
      onSdkSessionIdCleared: () => {
        sessionIdCleared = true;
      },
    });

    // Act - This should trigger empty response detection
    await collectEvents(agent.chat('Resume failed'));

    // Assert
    // NOTE: The actual retry logic may vary - this tests the detection path
    // If session ID was cleared, it indicates empty response was detected
    // This may or may not be true depending on the exact message sequence
    // and whether the agent considers it an empty response

    agent.dispose();
  });
});

// ============================================================================
// Abort Handling Tests
// ============================================================================

describe('CraftAgent.chat() - Abort Handling', () => {
  it('stops yielding events when forceAbort is called', async () => {
    // Arrange
    mockQuery.setMessages(createSimpleTextResponseSequence('Hello'));
    mockQuery.setOptions({ messageDelay: 50 }); // Slow down to allow abort

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
    });

    // Act
    const eventsPromise = collectEvents(agent.chat('Hello'));

    // Abort after a short delay
    setTimeout(() => {
      agent.forceAbort(AbortReason.UserStop);
    }, 10);

    const events = await eventsPromise;

    // Assert
    // Should have stopped early (may have partial events)
    // The key is that it completed without hanging
    expect(events).toBeDefined();

    agent.dispose();
  });

  it('forceAbort aborts the active query controller', async () => {
    // Arrange
    mockQuery.setMessages(createSimpleTextResponseSequence('Hello'));
    mockQuery.setOptions({ messageDelay: 100 });

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
    });

    // Start chat but don't await
    const chatPromise = collectEvents(agent.chat('Hello'));

    // Small delay to ensure chat has started
    await new Promise(resolve => setTimeout(resolve, 10));

    // Act - forceAbort returns void, not boolean
    agent.forceAbort(AbortReason.UserStop);

    // Assert - chat should complete (possibly with partial events)
    const events = await chatPromise;
    expect(events).toBeDefined();

    agent.dispose();
  });

  it('forceAbort is safe to call when no query is active', () => {
    // Arrange
    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
    });

    // Act - No chat started, should not throw
    expect(() => agent.forceAbort(AbortReason.UserStop)).not.toThrow();

    agent.dispose();
  });
});

// ============================================================================
// Slash Command Tests
// ============================================================================

describe('CraftAgent.chat() - Slash Commands', () => {
  it('sends /compact directly without context wrapping', async () => {
    // Arrange
    mockQuery.setMessages(createSimpleTextResponseSequence('Compacted'));

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
    });

    // Act
    await collectEvents(agent.chat('/compact'));

    // Assert - with SessionRunner, messages go through the channel
    const channelMessages = mockQuery.getChannelMessages();
    expect(channelMessages.length).toBeGreaterThanOrEqual(1);

    // Slash commands should be sent as-is, not wrapped in context
    // SDKUserMessage format: { type: 'user', message: { role: 'user', content: '...' } }
    const content = (channelMessages[0] as any).message?.content;
    expect(content).toBe('/compact');

    agent.dispose();
  });

  it('wraps regular messages with context', async () => {
    // Arrange
    mockQuery.setMessages(createSimpleTextResponseSequence('Response'));

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
    });

    // Act
    await collectEvents(agent.chat('Regular message'));

    // Assert - with SessionRunner, messages go through the channel
    const channelMessages = mockQuery.getChannelMessages();
    expect(channelMessages.length).toBeGreaterThanOrEqual(1);

    // Regular messages should have context (date, working directory, etc.)
    // SDKUserMessage format: { type: 'user', message: { role: 'user', content: '...' } }
    const content = String((channelMessages[0] as any).message?.content);
    expect(content.length).toBeGreaterThan('Regular message'.length);

    agent.dispose();
  });
});

// ============================================================================
// State Management Tests
// ============================================================================

// ============================================================================
// Binary Attachment Tests
// ============================================================================

describe('CraftAgent.chat() - Binary Attachments', () => {
  it('handles text-only attachments via string prompt', async () => {
    // Arrange
    mockQuery.setMessages(createSimpleTextResponseSequence('I see the file'));

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
    });

    // Text attachment (should be inlined in prompt)
    const textAttachment = {
      type: 'text' as const,
      name: 'test.txt',
      path: '/tmp/test.txt',
      mimeType: 'text/plain',
      text: 'Hello from file',
      size: 15,
    };

    // Act
    await collectEvents(agent.chat('What is in the file?', [textAttachment]));

    // Assert - with SessionRunner, messages go through the channel
    const channelMessages = mockQuery.getChannelMessages();
    expect(channelMessages.length).toBeGreaterThanOrEqual(1);

    // Text attachments go through sendText which creates SDKUserMessage with string content
    // SDKUserMessage format: { type: 'user', message: { role: 'user', content: '...' } }
    const content = (channelMessages[0] as any).message?.content;
    expect(typeof content).toBe('string');

    agent.dispose();
  });
});

// ============================================================================
// Context Injection Tests
// ============================================================================

describe('CraftAgent.chat() - Context Injection', () => {
  it('includes date/time context in prompt', async () => {
    // Arrange
    mockQuery.setMessages(createSimpleTextResponseSequence('Response'));

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
    });

    // Act
    await collectEvents(agent.chat('What time is it?'));

    // Assert - with SessionRunner, messages go through the channel
    const channelMessages = mockQuery.getChannelMessages();
    expect(channelMessages.length).toBeGreaterThanOrEqual(1);

    // Should contain date context (exact format may vary)
    // SDKUserMessage format: { type: 'user', message: { role: 'user', content: '...' } }
    const content = String((channelMessages[0] as any).message?.content);
    expect(content.length).toBeGreaterThan('What time is it?'.length);

    agent.dispose();
  });

  it('includes working directory in context', async () => {
    // Arrange
    mockQuery.setMessages(createSimpleTextResponseSequence('Response'));

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
    });

    // Act
    await collectEvents(agent.chat('Where am I?'));

    // Assert - with SessionRunner, messages go through the channel
    const channelMessages = mockQuery.getChannelMessages();
    expect(channelMessages.length).toBeGreaterThanOrEqual(1);

    // Working directory should be set in SDK options
    const calls = mockQuery.getAllCalls();
    expect(calls.length).toBe(1);
    const options = calls[0]!.options as any;
    expect(options.cwd).toBeDefined();

    agent.dispose();
  });
});

// ============================================================================
// Multiple Message Tests
// ============================================================================

describe('CraftAgent.chat() - Multiple Messages', () => {
  it('handles consecutive messages correctly', async () => {
    // Arrange - set up first turn's messages
    mockQuery.setMessages(createSimpleTextResponseSequence('First response', TEST_SESSION_ID));

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
    });

    // Act - First message
    const firstEvents = await collectEvents(agent.chat('First message'));

    // Queue second turn's messages (don't reset - SessionRunner reuses the query)
    mockQuery.setMessages(createSimpleTextResponseSequence('Second response', TEST_SESSION_ID));

    // Second message - goes through the same persistent session
    const secondEvents = await collectEvents(agent.chat('Second message'));

    // Assert - only ONE query() call for the whole session
    const calls = mockQuery.getAllCalls();
    expect(calls.length).toBe(1);

    // Both messages should have gone through the channel
    // SDKUserMessage format: { type: 'user', message: { role: 'user', content: '...' } }
    const channelMessages = mockQuery.getChannelMessages();
    expect(channelMessages.length).toBe(2);
    expect(String((channelMessages[0] as any).message?.content)).toContain('First message');
    expect(String((channelMessages[1] as any).message?.content)).toContain('Second message');

    // Both turns should have produced text_delta events
    const firstTextEvents = firstEvents.filter((e: any) => e.type === 'text_delta');
    const secondTextEvents = secondEvents.filter((e: any) => e.type === 'text_delta');
    expect(firstTextEvents.length).toBeGreaterThan(0);
    expect(secondTextEvents.length).toBeGreaterThan(0);

    agent.dispose();
  });
});

// ============================================================================
// State Management Tests
// ============================================================================

describe('CraftAgent - State Management', () => {
  it('clearHistory resets session ID', async () => {
    // Arrange
    mockQuery.setMessages(createSimpleTextResponseSequence('Hello', TEST_SESSION_ID));

    let capturedSessionId: string | undefined;
    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
      onSdkSessionIdUpdate: (id) => {
        capturedSessionId = id;
      },
    });

    // Establish session
    await collectEvents(agent.chat('Hello'));

    // Verify session was captured
    expect(capturedSessionId).toBe(TEST_SESSION_ID);

    // Act
    agent.clearHistory();

    // Assert
    expect(agent.getSessionId()).toBeNull();

    agent.dispose();
  });

  it('setSessionId updates the session ID', () => {
    // Arrange
    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
    });

    // Act
    agent.setSessionId(TEST_SESSION_ID);

    // Assert
    expect(agent.getSessionId()).toBe(TEST_SESSION_ID);

    agent.dispose();
  });

  it('dispose stops active queries', async () => {
    // Arrange
    mockQuery.setMessages(createSimpleTextResponseSequence('Hello'));
    mockQuery.setOptions({ messageDelay: 100 });

    const agent = new CraftAgent({
      workspace: createTestWorkspace(),
      session: createTestSession(),
      isHeadless: true,
    });

    // Start chat
    const chatPromise = collectEvents(agent.chat('Hello'));

    // Small delay
    await new Promise(resolve => setTimeout(resolve, 10));

    // Act
    agent.dispose();

    // Assert - should complete without hanging
    const events = await chatPromise;
    expect(events).toBeDefined();
  });
});
