import { describe, it, expect } from 'bun:test';
import { createBridge, createMockTransport } from '../bridge.ts';

describe('Bridge', () => {
  it('sendToHost sends message with correct type and requestId', () => {
    const { transport, getSentMessages } = createMockTransport();
    const bridge = createBridge(transport);

    bridge.sendToHost('APP_RUN_SCRIPT', { scriptName: 'list' });

    const messages = getSentMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe('APP_RUN_SCRIPT');
    expect(messages[0]!.requestId).toBeDefined();
    expect(messages[0]!.scriptName).toBe('list');
  });

  it('sendToHost supports APP_OPEN_URL payloads', () => {
    const { transport, getSentMessages } = createMockTransport();
    const bridge = createBridge(transport);

    bridge.sendToHost('APP_OPEN_URL', { url: 'https://craft.do' });

    const messages = getSentMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe('APP_OPEN_URL');
    expect(messages[0]!.requestId).toBeDefined();
    expect(messages[0]!.url).toBe('https://craft.do');
  });

  it('resolves promise when response matches requestId', async () => {
    const { transport, simulateResponse, getSentMessages } = createMockTransport();
    const bridge = createBridge(transport);

    const promise = bridge.sendToHost('APP_RUN_SCRIPT', { scriptName: 'list' });

    const sent = getSentMessages()[0]!;
    simulateResponse({
      type: 'response',
      requestId: sent.requestId,
      result: { items: [1, 2, 3] },
    });

    const result = await promise;
    expect(result).toEqual({ items: [1, 2, 3] });
  });

  it('rejects promise when response has error field', async () => {
    const { transport, simulateResponse, getSentMessages } = createMockTransport();
    const bridge = createBridge(transport);

    const promise = bridge.sendToHost('APP_RUN_SCRIPT', { scriptName: 'fail' });

    const sent = getSentMessages()[0]!;
    simulateResponse({
      type: 'response',
      requestId: sent.requestId,
      error: 'Script failed',
    });

    await expect(promise).rejects.toThrow('Script failed');
  });

  it('resolves APP_OPEN_URL requests when host responds', async () => {
    const { transport, simulateResponse, getSentMessages } = createMockTransport();
    const bridge = createBridge(transport);

    const promise = bridge.sendToHost('APP_OPEN_URL', { url: 'https://craft.do/docs' });
    const sent = getSentMessages()[0]!;

    simulateResponse({
      type: 'response',
      requestId: sent.requestId,
      result: { ok: true },
    });

    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('ignores responses with unmatched requestId', async () => {
    const { transport, simulateResponse, getSentMessages } = createMockTransport();
    const bridge = createBridge(transport);

    const promise = bridge.sendToHost('APP_RUN_SCRIPT', { scriptName: 'list' });

    // Send response with wrong requestId
    simulateResponse({
      type: 'response',
      requestId: 'wrong-id',
      result: 'should be ignored',
    });

    // Send correct response
    const sent = getSentMessages()[0]!;
    simulateResponse({
      type: 'response',
      requestId: sent.requestId,
      result: 'correct',
    });

    const result = await promise;
    expect(result).toBe('correct');
  });

  it('resolves multiple concurrent requests independently', async () => {
    const { transport, simulateResponse, getSentMessages } = createMockTransport();
    const bridge = createBridge(transport);

    const promise1 = bridge.sendToHost('APP_RUN_SCRIPT', { scriptName: 'first' });
    const promise2 = bridge.sendToHost('APP_RUN_SCRIPT', { scriptName: 'second' });

    const messages = getSentMessages();
    expect(messages).toHaveLength(2);

    // Respond to second first
    simulateResponse({
      type: 'response',
      requestId: messages[1]!.requestId,
      result: 'result-2',
    });

    simulateResponse({
      type: 'response',
      requestId: messages[0]!.requestId,
      result: 'result-1',
    });

    expect(await promise1).toBe('result-1');
    expect(await promise2).toBe('result-2');
  });

  it('routes messages to type-specific handlers', () => {
    const { transport, simulateResponse } = createMockTransport();
    const bridge = createBridge(transport);

    const received: string[] = [];
    bridge.onHostMessage('THEME_CHANGED', (msg) => {
      received.push(msg.theme as string);
    });

    simulateResponse({
      type: 'THEME_CHANGED',
      requestId: 'broadcast-1',
      theme: 'dark',
    });

    expect(received).toEqual(['dark']);
  });
});
