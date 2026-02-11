/**
 * Integration-style tests for credential proxy env propagation to non-Claude backends.
 *
 * Verifies Codex and Copilot subprocess clients receive HTTP(S)_PROXY and related
 * certificate env vars when setProxyConfig() is active.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { clearProxyConfig, setProxyConfig } from '../options.ts';

let lastCodexClientOptions: { env?: Record<string, string> } | null = null;
let lastCopilotClientOptions: { env?: Record<string, string | undefined> } | null = null;

mock.module('../../codex/binary-resolver.ts', () => ({
  resolveCodexBinary: () => ({ path: 'codex', source: 'test' }),
}));

mock.module('../../codex/app-server-client.ts', () => {
  class MockAppServerClient extends EventEmitter {
    private connected = false;

    constructor(options: { env?: Record<string, string> }) {
      super();
      lastCodexClientOptions = options;
    }

    async connect(): Promise<void> {
      this.connected = true;
    }

    isConnected(): boolean {
      return this.connected;
    }
  }

  return { AppServerClient: MockAppServerClient };
});

mock.module('@github/copilot-sdk', () => {
  class MockCopilotClient {
    constructor(options: { env?: Record<string, string | undefined> }) {
      lastCopilotClientOptions = options;
    }

    async start(): Promise<void> {
      return;
    }

    async listModels(): Promise<Array<{ id: string; supportedReasoningEfforts?: string[] }>> {
      return [];
    }
  }

  class MockCopilotSession {}

  return {
    CopilotClient: MockCopilotClient,
    CopilotSession: MockCopilotSession,
  };
});

const workspace = {
  id: 'ws-test',
  rootPath: '/tmp/ws-test',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const session = {
  id: 'session-test',
  workspaceId: 'ws-test',
  workspaceRootPath: '/tmp/ws-test',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

describe('credential proxy env in Codex/Copilot backends', () => {
  beforeEach(() => {
    lastCodexClientOptions = null;
    lastCopilotClientOptions = null;
    clearProxyConfig();
  });

  afterEach(() => {
    clearProxyConfig();
  });

  it('passes proxy env to Codex app-server client', async () => {
    setProxyConfig({
      sessionId: 'proxy-codex',
      port: 17777,
      caCertPath: '/tmp/proxy-ca.crt',
      caBundlePath: '/tmp/proxy-ca-bundle.pem',
    });

    const { CodexAgent } = await import('../codex-agent.ts');
    const agent = new CodexAgent({
      provider: 'openai',
      workspace,
      session,
      isHeadless: true,
    } as any);

    await (agent as any).ensureClient();

    const env = lastCodexClientOptions?.env;
    expect(env?.HTTP_PROXY).toBe('http://session-proxy-codex:session@127.0.0.1:17777');
    expect(env?.HTTPS_PROXY).toBe('http://session-proxy-codex:session@127.0.0.1:17777');
    expect(env?.NODE_USE_ENV_PROXY).toBe('1');
    expect(env?.NODE_EXTRA_CA_CERTS).toBe('/tmp/proxy-ca.crt');
    expect(env?.SSL_CERT_FILE).toBe('/tmp/proxy-ca-bundle.pem');
  });

  it('passes proxy env to Copilot client subprocess', async () => {
    setProxyConfig({
      sessionId: 'proxy-copilot',
      port: 18888,
      caCertPath: '/tmp/proxy-ca.crt',
      caBundlePath: '/tmp/proxy-ca-bundle.pem',
    });

    const { CopilotAgent } = await import('../copilot-agent.ts');
    const agent = new CopilotAgent({
      provider: 'copilot',
      workspace,
      session,
      isHeadless: true,
    } as any);

    await (agent as any).ensureClient();

    const env = lastCopilotClientOptions?.env;
    expect(env?.HTTP_PROXY).toBe('http://session-proxy-copilot:session@127.0.0.1:18888');
    expect(env?.HTTPS_PROXY).toBe('http://session-proxy-copilot:session@127.0.0.1:18888');
    expect(env?.NODE_USE_ENV_PROXY).toBe('1');
    expect(env?.NODE_EXTRA_CA_CERTS).toBe('/tmp/proxy-ca.crt');
    expect(env?.SSL_CERT_FILE).toBe('/tmp/proxy-ca-bundle.pem');
  });
});
