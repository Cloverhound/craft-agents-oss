/**
 * Credential OAuth 2.0 + PKCE Flow
 *
 * Handles OAuth authentication for credential configs that use auth.type: "oauth2".
 * This is a self-contained flow that:
 * 1. Reads OAuth config (authorizeUrl, tokenUrl, scopes) from credential config
 * 2. Loads client_id/client_secret from encrypted store
 * 3. Generates PKCE challenge
 * 4. Opens browser to authorization URL
 * 5. Starts local callback server
 * 6. Exchanges authorization code for tokens
 * 7. Stores tokens in encrypted store
 *
 * This follows the same patterns as the existing CraftOAuth class but is
 * tailored for user-provided OAuth apps (e.g., Xero, custom APIs).
 */

import { createServer, type Server } from 'http';
import { URL } from 'url';
import { randomBytes, createHash } from 'crypto';
import { openUrl } from '../utils/open-url.ts';
import { generateCallbackPage } from '../auth/callback-page.ts';
import { debug } from '../utils/debug.ts';
import type { OAuth2AuthConfig } from './credential-config-types.ts';

// Default port range for callback server
const DEFAULT_CALLBACK_PORT_START = 9876;
const DEFAULT_CALLBACK_PORT_END = 9886;
const CALLBACK_PATH = '/callback';

/**
 * PKCE helper
 */
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function generateState(): string {
  return randomBytes(16).toString('hex');
}

export interface CredentialOAuthOptions {
  /** OAuth2 config from credential config */
  oauthConfig: OAuth2AuthConfig;
  /** Client ID (loaded from encrypted store) */
  clientId: string;
  /** Client Secret (loaded from encrypted store) */
  clientSecret: string;
}

export interface CredentialOAuthResult {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  error?: string;
}

/**
 * Run the full OAuth 2.0 + PKCE flow for a credential.
 *
 * Opens a browser, captures the callback, exchanges the code for tokens.
 * Returns the tokens (caller is responsible for storing them).
 */
export async function runCredentialOAuthFlow(
  options: CredentialOAuthOptions
): Promise<CredentialOAuthResult> {
  const { oauthConfig, clientId, clientSecret } = options;
  const pkce = generatePKCE();
  const state = generateState();

  // Determine callback port
  const portStart = oauthConfig.callbackPort ?? DEFAULT_CALLBACK_PORT_START;
  const portEnd = oauthConfig.callbackPort
    ? oauthConfig.callbackPort // If specific port requested, only try that one
    : DEFAULT_CALLBACK_PORT_END;

  // Try to start callback server on available port
  let server: Server | null = null;
  let port: number = portStart;

  for (let p = portStart; p <= portEnd; p++) {
    try {
      server = await startCallbackServer(p);
      port = p;
      break;
    } catch {
      continue;
    }
  }

  if (!server) {
    return {
      success: false,
      error: `Could not start callback server on ports ${portStart}-${portEnd}`,
    };
  }

  const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;

  // Build authorization URL
  const authorizeUrl = new URL(oauthConfig.authorizeUrl);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', oauthConfig.scopes.join(' '));
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', pkce.challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  try {
    // Open browser
    debug('[CredentialOAuth] Opening browser for authorization');
    await openUrl(authorizeUrl.toString());

    // Wait for callback
    const callbackResult = await waitForCallback(server, state);

    if (!callbackResult.code) {
      return {
        success: false,
        error: callbackResult.error || 'No authorization code received',
      };
    }

    // Exchange code for tokens
    debug('[CredentialOAuth] Exchanging code for tokens');
    const tokenResult = await exchangeCodeForTokens({
      tokenUrl: oauthConfig.tokenUrl,
      code: callbackResult.code,
      redirectUri,
      clientId,
      clientSecret,
      codeVerifier: pkce.verifier,
    });

    return tokenResult;
  } finally {
    // Always close the server
    server.close();
  }
}

/**
 * Refresh an OAuth 2.0 access token using a refresh token.
 */
export async function refreshCredentialToken(
  tokenUrl: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<CredentialOAuthResult> {
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      debug(`[CredentialOAuth] Token refresh failed: ${response.status} ${errorBody}`);
      return {
        success: false,
        error: `Token refresh failed: HTTP ${response.status}`,
      };
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    return {
      success: true,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken, // Use new refresh token if provided
      expiresAt: data.expires_in
        ? Date.now() + data.expires_in * 1000
        : undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: `Token refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================================
// Internal helpers
// ============================================================

function startCallbackServer(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

interface CallbackResult {
  code?: string;
  error?: string;
}

function waitForCallback(server: Server, expectedState: string): Promise<CallbackResult> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ error: 'OAuth callback timed out after 5 minutes' });
    }, 5 * 60 * 1000);

    server.on('request', (req, res) => {
      const url = new URL(req.url || '/', `http://localhost`);

      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      // Serve the callback page
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(generateCallbackPage({
        isSuccess: !error && !!code,
        title: error ? 'Authentication Failed' : 'Authentication Successful',
        errorDetail: error || undefined,
      }));

      clearTimeout(timeout);

      if (error) {
        resolve({ error: `OAuth error: ${error}` });
        return;
      }

      if (state !== expectedState) {
        resolve({ error: 'OAuth state mismatch (possible CSRF attack)' });
        return;
      }

      if (!code) {
        resolve({ error: 'No authorization code in callback' });
        return;
      }

      resolve({ code });
    });
  });
}

async function exchangeCodeForTokens(params: {
  tokenUrl: string;
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  codeVerifier: string;
}): Promise<CredentialOAuthResult> {
  try {
    const response = await fetch(params.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: params.redirectUri,
        client_id: params.clientId,
        client_secret: params.clientSecret,
        code_verifier: params.codeVerifier,
      }).toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      debug(`[CredentialOAuth] Token exchange failed: ${response.status} ${errorBody}`);
      return {
        success: false,
        error: `Token exchange failed: HTTP ${response.status}`,
      };
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    return {
      success: true,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in
        ? Date.now() + data.expires_in * 1000
        : undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: `Token exchange failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
