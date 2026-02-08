/**
 * Credential Tools
 *
 * Session-scoped tools for credential lifecycle management.
 * These tools handle setup, OAuth flows, testing, and listing —
 * the LLM never sees secrets. They follow the same patterns as
 * source tools in session-scoped-tools.ts.
 *
 * Tools:
 * - credential_prompt: Prompt user for static credentials (API keys, tokens)
 * - credential_oauth_client: Prompt for OAuth client_id + client_secret
 * - credential_oauth: Initiate OAuth 2.0 + PKCE browser flow
 * - credential_test: Verify credentials work via test request
 * - credential_list: List all credentials with status
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { basename } from 'path';
import { debug } from '../utils/debug.ts';
import { getCredentialManager } from './index.ts';
import type { CredentialId, StoredCredential } from './types.ts';
import {
  loadCredentialConfig,
  loadCredentialRegistry,
  saveCredentialConfig,
} from './registry.ts';
import { matchCredential } from './matcher.ts';
import type { CredentialAuthConfig, LoadedCredentialConfig, OAuth2AuthConfig } from './credential-config-types.ts';
import type { SessionScopedToolCallbacks, CredentialInputMode } from '../agent/session-scoped-tools.ts';

// ============================================================
// Credential Key Helpers
// ============================================================

/**
 * Map credential auth type to the credential store type used for storage.
 */
function authTypeToStoreType(authType: CredentialAuthConfig['type']): string {
  switch (authType) {
    case 'oauth2':
      return 'source_oauth';
    case 'bearer':
      return 'source_bearer';
    case 'basic':
      return 'source_basic';
    case 'header':
    case 'multi-header':
    case 'query':
    default:
      return 'source_apikey';
  }
}

/**
 * Build the credential store key for a workspace credential.
 * Uses a distinct prefix 'credential' to avoid collisions with source credentials.
 */
function getCredentialStoreId(workspaceId: string, slug: string, authType?: CredentialAuthConfig['type']): CredentialId {
  return {
    type: authTypeToStoreType(authType ?? 'header') as any,
    workspaceId,
    sourceId: `cred_${slug}`, // Prefix to distinguish from source credentials
  };
}

/**
 * Build the credential store key for OAuth tokens.
 */
function getOAuthTokenStoreId(workspaceId: string, slug: string): CredentialId {
  return {
    type: 'source_oauth',
    workspaceId,
    sourceId: `cred_${slug}`,
  };
}

/**
 * Build the credential store key for OAuth client credentials.
 */
function getOAuthClientStoreId(workspaceId: string, slug: string): CredentialId {
  return {
    type: 'source_apikey',
    workspaceId,
    sourceId: `cred_client_${slug}`,
  };
}

// ============================================================
// Callback type for credential auth requests
// ============================================================

/**
 * Credential-specific auth request (extends source pattern)
 */
export interface CredentialAuthRequestInfo {
  type: 'credential-prompt' | 'credential-oauth-client';
  requestId: string;
  sessionId: string;
  credentialSlug: string;
  credentialName: string;
  mode: CredentialInputMode;
  labels?: {
    credential?: string;
    username?: string;
    password?: string;
  };
  description?: string;
  hint?: string;
  headerNames?: string[];
}

// ============================================================
// Tool Factories
// ============================================================

/**
 * Get callbacks for a session (imported from session-scoped-tools)
 */
type GetCallbacksFn = (sessionId: string) => SessionScopedToolCallbacks | undefined;

/**
 * Create the credential_prompt tool.
 * Prompts user for static credentials (API keys, tokens, basic auth).
 */
export function createCredentialPromptTool(
  sessionId: string,
  workspaceRootPath: string,
  getCallbacks: GetCallbacksFn
) {
  return tool(
    'credential_prompt',
    `Prompt the user to enter credentials for an API.

Use this to securely collect API keys, bearer tokens, or basic auth credentials.
The user sees a secure input UI — you never see the actual secret values.

**Auth Modes:**
- \`bearer\`: Single token field (API Key, Bearer Token)
- \`basic\`: Username and Password fields
- \`header\`: API Key for custom header injection
- \`query\`: API Key for query parameter injection
- \`multi-header\`: Multiple header fields (e.g., Datadog)

**Prerequisites:**
- Credential config must exist at credentials/{slug}.json

**IMPORTANT:** After calling this tool:
- Execution will be **automatically paused** to show the credential input UI
- Once the user completes or cancels, you'll receive a message with the result
- Do NOT include any text or tool calls after this tool`,
    {
      slug: z.string().describe('The credential slug (must match a credentials/{slug}.json config)'),
      mode: z.enum(['bearer', 'basic', 'header', 'query', 'multi-header']).describe('Type of credential input'),
      labels: z.object({
        credential: z.string().optional(),
        username: z.string().optional(),
        password: z.string().optional(),
      }).optional().describe('Custom field labels'),
      description: z.string().optional().describe('Description shown to user'),
      hint: z.string().optional().describe('Hint about where to find credentials'),
    },
    async (args) => {
      debug('[credential_prompt] Requesting credentials for:', args.slug);

      const config = loadCredentialConfig(workspaceRootPath, args.slug);
      if (!config) {
        return {
          content: [{
            type: 'text' as const,
            text: `Credential config '${args.slug}' not found. Create it first at credentials/${args.slug}.json`,
          }],
          isError: true,
        };
      }

      const callbacks = getCallbacks(sessionId);
      if (!callbacks?.onAuthRequest) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Error: No auth request handler available. This tool requires a UI.',
          }],
          isError: true,
        };
      }

      // Detect header names for multi-header mode
      let headerNames: string[] | undefined;
      if (config.auth.type === 'multi-header') {
        headerNames = config.auth.headerNames;
      }

      // Build auth request using the existing source credential prompt pattern
      // We reuse the same 'credential' type that session-scoped-tools understands
      const authRequest = {
        type: 'credential' as const,
        requestId: crypto.randomUUID(),
        sessionId,
        sourceSlug: `cred_${args.slug}`, // Prefix to store under credential namespace
        sourceName: config.name,
        mode: args.mode,
        labels: args.labels,
        description: args.description || `Enter credentials for ${config.name}`,
        hint: args.hint,
        headerNames,
      };

      callbacks.onAuthRequest(authRequest);

      return {
        content: [{
          type: 'text' as const,
          text: `Credential input requested for '${config.name}'. Waiting for user input.`,
        }],
        isError: false,
      };
    }
  );
}

/**
 * Create the credential_oauth_client tool.
 * Securely prompts for OAuth client_id and client_secret.
 */
export function createCredentialOAuthClientTool(
  sessionId: string,
  workspaceRootPath: string,
  getCallbacks: GetCallbacksFn
) {
  return tool(
    'credential_oauth_client',
    `Prompt the user for OAuth client credentials (client_id and client_secret).

Use this before \`credential_oauth\` for services that require OAuth 2.0 (like Xero).
The user provides their app's client ID and secret via a secure two-field input.

**IMPORTANT:** After calling this tool:
- Execution will be **automatically paused** to show the credential input UI
- Once the user completes or cancels, you'll receive a message with the result
- Do NOT include any text or tool calls after this tool`,
    {
      slug: z.string().describe('The credential slug (must match a credentials/{slug}.json config with auth.type: "oauth2")'),
      description: z.string().optional().describe('Description shown to user'),
      hint: z.string().optional().describe('Hint about where to create/find the app credentials'),
    },
    async (args) => {
      debug('[credential_oauth_client] Requesting OAuth client creds for:', args.slug);

      const config = loadCredentialConfig(workspaceRootPath, args.slug);
      if (!config) {
        return {
          content: [{
            type: 'text' as const,
            text: `Credential config '${args.slug}' not found. Create it first at credentials/${args.slug}.json`,
          }],
          isError: true,
        };
      }

      if (config.auth.type !== 'oauth2') {
        return {
          content: [{
            type: 'text' as const,
            text: `Credential '${args.slug}' uses auth type '${config.auth.type}', not 'oauth2'. Use credential_prompt instead.`,
          }],
          isError: true,
        };
      }

      const callbacks = getCallbacks(sessionId);
      if (!callbacks?.onAuthRequest) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Error: No auth request handler available. This tool requires a UI.',
          }],
          isError: true,
        };
      }

      // Use multi-header mode to collect client_id and client_secret
      const authRequest = {
        type: 'credential' as const,
        requestId: crypto.randomUUID(),
        sessionId,
        sourceSlug: `cred_client_${args.slug}`, // Store under client credential namespace
        sourceName: `${config.name} (OAuth App)`,
        mode: 'multi-header' as const,
        labels: { credential: 'OAuth Credentials' },
        description: args.description || `Enter OAuth app credentials for ${config.name}`,
        hint: args.hint,
        headerNames: ['client_id', 'client_secret'],
      };

      callbacks.onAuthRequest(authRequest);

      return {
        content: [{
          type: 'text' as const,
          text: `OAuth client credential input requested for '${config.name}'. Waiting for user input.`,
        }],
        isError: false,
      };
    }
  );
}

/**
 * Create the credential_oauth tool.
 * Initiates OAuth 2.0 + PKCE browser flow.
 */
export function createCredentialOAuthTool(
  sessionId: string,
  workspaceRootPath: string,
  getCallbacks: GetCallbacksFn
) {
  return tool(
    'credential_oauth',
    `Initiate OAuth 2.0 + PKCE authentication for a credential.

Opens a browser window for the user to sign in and authorize.
Requires that client credentials have been set up first via \`credential_oauth_client\`.

**Prerequisites:**
- Credential config must exist with auth.type: "oauth2"
- Client credentials must be stored (via credential_oauth_client)

**IMPORTANT:** After calling this tool:
- Execution will be **automatically paused** while OAuth completes
- A browser window will open for authentication
- Once complete or cancelled, you'll receive a message with the result
- Do NOT include any text or tool calls after this tool`,
    {
      slug: z.string().describe('The credential slug'),
    },
    async (args) => {
      debug('[credential_oauth] Starting OAuth for:', args.slug);

      const config = loadCredentialConfig(workspaceRootPath, args.slug);
      if (!config) {
        return {
          content: [{
            type: 'text' as const,
            text: `Credential config '${args.slug}' not found.`,
          }],
          isError: true,
        };
      }

      if (config.auth.type !== 'oauth2') {
        return {
          content: [{
            type: 'text' as const,
            text: `Credential '${args.slug}' uses auth type '${config.auth.type}', not 'oauth2'.`,
          }],
          isError: true,
        };
      }

      // Check for client credentials
      const credManager = getCredentialManager();
      const workspaceId = basename(workspaceRootPath);
      const clientCredsId = getOAuthClientStoreId(workspaceId, args.slug);
      const clientCreds = await credManager.get(clientCredsId);

      if (!clientCreds?.value) {
        return {
          content: [{
            type: 'text' as const,
            text: `No OAuth client credentials found for '${args.slug}'. Run credential_oauth_client first.`,
          }],
          isError: true,
        };
      }

      // Parse client credentials (stored as JSON { client_id, client_secret })
      let clientId: string;
      let clientSecret: string;
      try {
        const parsed = JSON.parse(clientCreds.value);
        clientId = parsed.client_id;
        clientSecret = parsed.client_secret;
        if (!clientId || !clientSecret) throw new Error('Missing fields');
      } catch {
        return {
          content: [{
            type: 'text' as const,
            text: `Invalid OAuth client credentials for '${args.slug}'. Re-run credential_oauth_client.`,
          }],
          isError: true,
        };
      }

      // Run the OAuth flow
      try {
        const { runCredentialOAuthFlow } = await import('./oauth-flow.ts');
        const result = await runCredentialOAuthFlow({
          oauthConfig: config.auth as OAuth2AuthConfig,
          clientId,
          clientSecret,
        });

        if (!result.success) {
          return {
            content: [{
              type: 'text' as const,
              text: `OAuth failed for '${config.name}': ${result.error}`,
            }],
            isError: true,
          };
        }

        // Store the tokens
        const tokenId = getOAuthTokenStoreId(workspaceId, args.slug);
        await credManager.set(tokenId, {
          value: result.accessToken!,
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt,
          clientId,
          clientSecret,
        });

        // Update config to mark authenticated
        config.isAuthenticated = true;
        config.lastTestedAt = Date.now();
        saveCredentialConfig(workspaceRootPath, config);

        return {
          content: [{
            type: 'text' as const,
            text: `Successfully authenticated with ${config.name}. Tokens stored securely.`,
          }],
          isError: false,
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `OAuth error for '${config.name}': ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );
}

/**
 * Test a credential by making its configured test request.
 * Loads the credential from the encrypted store, makes the HTTP request,
 * and updates isAuthenticated + lastTestedAt in the config file.
 *
 * This is the shared implementation used by both the MCP tool and IPC handler.
 */
export async function testCredential(
  workspaceRootPath: string,
  slug: string
): Promise<{ ok: boolean; status?: number; error?: string }> {
  debug('[testCredential] Testing:', slug);

  const config = loadCredentialConfig(workspaceRootPath, slug);
  if (!config) {
    return { ok: false, error: `Credential config '${slug}' not found.` };
  }

  if (!config.testRequest) {
    // No test endpoint configured — nothing to test, assume ok
    return { ok: true };
  }

  // Load the credential
  const credManager = getCredentialManager();
  const workspaceId = basename(workspaceRootPath);

  // Try OAuth tokens first, then static credentials
  let token: string | null = null;
  let authHeaders: Record<string, string> = {};

  if (config.auth.type === 'oauth2') {
    const tokenId = getOAuthTokenStoreId(workspaceId, slug);
    const stored = await credManager.get(tokenId);
    if (stored?.value) {
      // Check expiry
      if (stored.expiresAt && Date.now() > stored.expiresAt - 60000) {
        // Try refresh
        if (stored.refreshToken && stored.clientId && stored.clientSecret) {
          const { refreshCredentialToken } = await import('./oauth-flow.ts');
          const refreshResult = await refreshCredentialToken(
            (config.auth as OAuth2AuthConfig).tokenUrl,
            stored.refreshToken,
            stored.clientId,
            stored.clientSecret
          );
          if (refreshResult.success && refreshResult.accessToken) {
            token = refreshResult.accessToken;
            // Update stored token
            await credManager.set(tokenId, {
              ...stored,
              value: refreshResult.accessToken,
              refreshToken: refreshResult.refreshToken || stored.refreshToken,
              expiresAt: refreshResult.expiresAt,
            });
          }
        }
      } else {
        token = stored.value;
      }
      if (token) {
        authHeaders['Authorization'] = `Bearer ${token}`;
      }
    }
  } else {
    const credId = getCredentialStoreId(workspaceId, slug, config.auth.type);
    const stored = await credManager.get(credId);
    if (stored?.value) {
      switch (config.auth.type) {
        case 'bearer': {
          const scheme = config.auth.scheme || 'Bearer';
          authHeaders['Authorization'] = `${scheme} ${stored.value}`;
          break;
        }
        case 'header': {
          authHeaders[config.auth.headerName] = stored.value;
          break;
        }
        case 'multi-header': {
          try {
            const parsed = JSON.parse(stored.value);
            Object.assign(authHeaders, parsed);
          } catch { /* ignore */ }
          break;
        }
        case 'basic': {
          try {
            const parsed = JSON.parse(stored.value);
            const basicAuth = Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64');
            authHeaders['Authorization'] = `Basic ${basicAuth}`;
          } catch { /* ignore */ }
          break;
        }
      }
    }
  }

  if (Object.keys(authHeaders).length === 0) {
    return { ok: false, error: `No credentials found for '${slug}'. Set up credentials first.` };
  }

  // Make the test request
  try {
    const response = await fetch(config.testRequest.url, {
      method: config.testRequest.method || 'GET',
      headers: authHeaders,
    });

    // Update config status
    config.isAuthenticated = response.ok;
    config.lastTestedAt = Date.now();
    saveCredentialConfig(workspaceRootPath, config);

    if (response.ok) {
      return { ok: true, status: response.status };
    } else {
      return { ok: false, status: response.status, error: `HTTP ${response.status}: ${response.statusText}` };
    }
  } catch (error) {
    config.isAuthenticated = false;
    config.lastTestedAt = Date.now();
    saveCredentialConfig(workspaceRootPath, config);

    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Create the credential_test tool.
 * Verifies credentials work by making the configured test request.
 */
export function createCredentialTestTool(
  sessionId: string,
  workspaceRootPath: string
) {
  return tool(
    'credential_test',
    `Test if credentials are valid by making a test request.

Uses the \`testRequest\` configured in the credential config.
Returns the HTTP status to verify authentication works.`,
    {
      slug: z.string().describe('The credential slug to test'),
    },
    async (args) => {
      const result = await testCredential(workspaceRootPath, args.slug);

      if (result.error) {
        return {
          content: [{
            type: 'text' as const,
            text: result.status
              ? `Credential '${args.slug}' test failed. ${result.error}`
              : result.error,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Credential '${args.slug}' is working. Test request returned HTTP ${result.status}.`,
        }],
        isError: false,
      };
    }
  );
}

/**
 * Create the credential_list tool.
 * Lists all credentials in the workspace with their status.
 */
export function createCredentialListTool(
  sessionId: string,
  workspaceRootPath: string
) {
  return tool(
    'credential_list',
    `List all registered credentials in the workspace with their authentication status.`,
    {},
    async () => {
      const registry = loadCredentialRegistry(workspaceRootPath);

      if (registry.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No credentials registered. Create credential configs at credentials/{slug}.json',
          }],
          isError: false,
        };
      }

      const lines: string[] = ['**Registered Credentials:**\n'];

      for (const cred of registry) {
        const status = cred.isAuthenticated ? '✓' : '○';
        const authType = cred.auth.type;
        const patterns = cred.urlPatterns.join(', ');
        lines.push(`- **${status} ${cred.name}** (\`${cred.slug}\`) — ${authType}`);
        lines.push(`  Patterns: ${patterns}`);
        if (cred.lastTestedAt) {
          const ago = Math.round((Date.now() - cred.lastTestedAt) / 60000);
          lines.push(`  Last tested: ${ago}m ago`);
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: lines.join('\n'),
        }],
        isError: false,
      };
    }
  );
}
