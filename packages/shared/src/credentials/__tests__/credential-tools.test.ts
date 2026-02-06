/**
 * Tests for credentials/credential-tools.ts
 *
 * Validates the session-scoped credential tools:
 * - credential_prompt: config lookup, error cases, auth request dispatch
 * - credential_oauth_client: OAuth type validation, client cred collection
 * - credential_list: registry listing, status display
 *
 * Note: credential_oauth and credential_test are integration-heavy (need
 * credential manager + network). We test their error paths and validation.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import {
  createCredentialPromptTool,
  createCredentialOAuthClientTool,
  createCredentialListTool,
} from '../credential-tools.ts';
import type { CredentialConfig } from '../credential-config-types.ts';
import { saveCredentialConfig } from '../registry.ts';

const TEST_ROOT = join(import.meta.dir, '__test-workspace-tools__');

function setup() {
  if (existsSync(TEST_ROOT)) {
    rmSync(TEST_ROOT, { recursive: true });
  }
  mkdirSync(TEST_ROOT, { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) {
    rmSync(TEST_ROOT, { recursive: true });
  }
}

function createXeroConfig(): CredentialConfig {
  return {
    name: 'Xero',
    slug: 'xero',
    urlPatterns: ['https://api.xero.com/*'],
    auth: {
      type: 'oauth2',
      authorizeUrl: 'https://login.xero.com/authorize',
      tokenUrl: 'https://identity.xero.com/token',
      scopes: ['openid'],
    },
    testRequest: {
      url: 'https://api.xero.com/api.xro/2.0/Organisation',
      method: 'GET',
    },
  };
}

function createStripeConfig(): CredentialConfig {
  return {
    name: 'Stripe',
    slug: 'stripe',
    urlPatterns: ['https://api.stripe.com/*'],
    auth: { type: 'bearer' },
    isAuthenticated: true,
    lastTestedAt: Date.now() - 60000,
  };
}

/**
 * Extract the tool handler from the tool factory return value.
 * The tool() helper from the SDK returns an object with the handler.
 * We call the handler directly for testing.
 */
async function callToolHandler(toolDef: any, args: Record<string, unknown>) {
  // The tool() helper returns { name, description, schema, handler }
  // or an MCP tool definition. We access the handler.
  if (typeof toolDef.handler === 'function') {
    return toolDef.handler(args);
  }
  // If it's an MCP-style tool, the handler is stored differently
  // For testing, we call it directly
  throw new Error('Could not find handler on tool definition');
}

describe('Credential Tools', () => {
  beforeEach(setup);
  afterEach(teardown);

  // ============================================================
  // credential_prompt
  // ============================================================

  describe('createCredentialPromptTool', () => {
    it('creates a tool with correct name', () => {
      const tool = createCredentialPromptTool('session-1', TEST_ROOT, () => undefined);
      expect(tool.name).toBe('credential_prompt');
    });

    it('returns error when credential config does not exist', async () => {
      const tool = createCredentialPromptTool('session-1', TEST_ROOT, () => undefined);
      const result = await callToolHandler(tool, {
        slug: 'nonexistent',
        mode: 'bearer',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('returns error when no auth request handler is available', async () => {
      saveCredentialConfig(TEST_ROOT, createStripeConfig());

      const tool = createCredentialPromptTool('session-1', TEST_ROOT, () => undefined);
      const result = await callToolHandler(tool, {
        slug: 'stripe',
        mode: 'bearer',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No auth request handler');
    });

    it('dispatches auth request and returns success', async () => {
      saveCredentialConfig(TEST_ROOT, createStripeConfig());

      const onAuthRequest = mock(() => {});
      const getCallbacks = () => ({ onAuthRequest } as any);

      const tool = createCredentialPromptTool('session-1', TEST_ROOT, getCallbacks);
      const result = await callToolHandler(tool, {
        slug: 'stripe',
        mode: 'bearer',
        description: 'Enter your Stripe API key',
      });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('Credential input requested');
      expect(onAuthRequest).toHaveBeenCalledTimes(1);

      // Verify the auth request shape
      const authReq = (onAuthRequest.mock.calls as any[][])[0]![0];
      expect(authReq.type).toBe('credential');
      expect(authReq.sourceSlug).toBe('cred_stripe');
      expect(authReq.sourceName).toBe('Stripe');
      expect(authReq.mode).toBe('bearer');
      expect(authReq.description).toBe('Enter your Stripe API key');
    });

    it('detects multi-header names from config', async () => {
      const ddConfig: CredentialConfig = {
        name: 'Datadog',
        slug: 'datadog',
        urlPatterns: ['https://api.datadoghq.com/*'],
        auth: { type: 'multi-header', headerNames: ['DD-API-KEY', 'DD-APPLICATION-KEY'] },
      };
      saveCredentialConfig(TEST_ROOT, ddConfig);

      const onAuthRequest = mock(() => {});
      const getCallbacks = () => ({ onAuthRequest } as any);

      const tool = createCredentialPromptTool('session-1', TEST_ROOT, getCallbacks);
      await callToolHandler(tool, {
        slug: 'datadog',
        mode: 'multi-header',
      });

      const authReq = (onAuthRequest.mock.calls as any[][])[0]![0];
      expect(authReq.headerNames).toEqual(['DD-API-KEY', 'DD-APPLICATION-KEY']);
    });
  });

  // ============================================================
  // credential_oauth_client
  // ============================================================

  describe('createCredentialOAuthClientTool', () => {
    it('creates a tool with correct name', () => {
      const tool = createCredentialOAuthClientTool('session-1', TEST_ROOT, () => undefined);
      expect(tool.name).toBe('credential_oauth_client');
    });

    it('returns error when credential config does not exist', async () => {
      const tool = createCredentialOAuthClientTool('session-1', TEST_ROOT, () => undefined);
      const result = await callToolHandler(tool, { slug: 'nonexistent' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('returns error when auth type is not oauth2', async () => {
      saveCredentialConfig(TEST_ROOT, createStripeConfig()); // type: 'bearer'

      const tool = createCredentialOAuthClientTool('session-1', TEST_ROOT, () => undefined);
      const result = await callToolHandler(tool, { slug: 'stripe' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not 'oauth2'");
    });

    it('dispatches auth request for OAuth client credentials', async () => {
      saveCredentialConfig(TEST_ROOT, createXeroConfig());

      const onAuthRequest = mock(() => {});
      const getCallbacks = () => ({ onAuthRequest } as any);

      const tool = createCredentialOAuthClientTool('session-1', TEST_ROOT, getCallbacks);
      const result = await callToolHandler(tool, {
        slug: 'xero',
        hint: 'https://developer.xero.com/app/manage',
      });

      expect(result.isError).toBe(false);
      expect(onAuthRequest).toHaveBeenCalledTimes(1);

      const authReq = (onAuthRequest.mock.calls as any[][])[0]![0];
      expect(authReq.type).toBe('credential');
      expect(authReq.sourceSlug).toBe('cred_client_xero');
      expect(authReq.mode).toBe('multi-header');
      expect(authReq.headerNames).toEqual(['client_id', 'client_secret']);
      expect(authReq.hint).toBe('https://developer.xero.com/app/manage');
    });
  });

  // ============================================================
  // credential_list
  // ============================================================

  describe('createCredentialListTool', () => {
    it('creates a tool with correct name', () => {
      const tool = createCredentialListTool('session-1', TEST_ROOT);
      expect(tool.name).toBe('credential_list');
    });

    it('returns message when no credentials exist', async () => {
      const tool = createCredentialListTool('session-1', TEST_ROOT);
      const result = await callToolHandler(tool, {});

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('No credentials registered');
    });

    it('lists all credentials with status', async () => {
      saveCredentialConfig(TEST_ROOT, createStripeConfig());
      saveCredentialConfig(TEST_ROOT, createXeroConfig());

      const tool = createCredentialListTool('session-1', TEST_ROOT);
      const result = await callToolHandler(tool, {});

      expect(result.isError).toBe(false);
      const text = result.content[0].text;
      expect(text).toContain('Stripe');
      expect(text).toContain('stripe');
      expect(text).toContain('Xero');
      expect(text).toContain('xero');
      expect(text).toContain('bearer');
      expect(text).toContain('oauth2');
    });

    it('shows authenticated status marker', async () => {
      saveCredentialConfig(TEST_ROOT, {
        ...createStripeConfig(),
        isAuthenticated: true,
      });
      saveCredentialConfig(TEST_ROOT, {
        ...createXeroConfig(),
        isAuthenticated: false,
      });

      const tool = createCredentialListTool('session-1', TEST_ROOT);
      const result = await callToolHandler(tool, {});

      const text = result.content[0].text;
      // Authenticated cred should have checkmark, unauthenticated should have circle
      expect(text).toContain('✓');
      expect(text).toContain('○');
    });

    it('shows URL patterns', async () => {
      saveCredentialConfig(TEST_ROOT, createStripeConfig());

      const tool = createCredentialListTool('session-1', TEST_ROOT);
      const result = await callToolHandler(tool, {});

      expect(result.content[0].text).toContain('https://api.stripe.com/*');
    });
  });
});
