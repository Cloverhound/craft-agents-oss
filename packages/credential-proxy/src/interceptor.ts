/**
 * Credential Interceptor
 *
 * Matches request URLs against credential URL patterns and injects
 * authentication headers/parameters. Ported from auth-curl's core.ts
 * to work at the HTTP proxy layer instead of as a CLI wrapper.
 *
 * Also handles:
 * - Hostname-level matching for CONNECT decisions (fast path)
 * - Full URL matching for credential injection
 * - Secret loading from encrypted credential store
 * - OAuth2 token refresh
 * - Permission mode enforcement (Explore mode method restrictions)
 */

import type {
  LoadedCredentialConfig,
  CredentialAuthConfig,
  OAuth2AuthConfig,
} from '@craft-agent/shared/credentials/credential-config-types';
import { matchUrlPattern } from '@craft-agent/shared/credentials/matcher';
import type { PermissionMode } from './session-registry';

export interface InterceptedHeaders {
  [name: string]: string;
}

export interface InterceptionResult {
  /** Headers to inject into the request */
  headers: InterceptedHeaders;
  /** Modified URL (for query param auth) */
  url: string;
  /** The credential that matched */
  credential: LoadedCredentialConfig;
}

export interface PermissionCheckResult {
  allowed: boolean;
  /** If not allowed, the reason to include in 403 response */
  reason?: string;
}

/**
 * Check if a hostname:port matches any credential's URL patterns.
 * This is the fast-path check used during CONNECT to decide MITM vs tunnel.
 *
 * We check if any pattern starts with a scheme + this hostname.
 */
export function hostnameMatchesCredentials(
  hostname: string,
  port: number,
  credentials: LoadedCredentialConfig[],
): boolean {
  // Build test URL prefixes for the hostname:port combination.
  // For default ports (443/80), patterns like "https://host/*" should match
  // but "https://host:8443/*" should NOT. For non-default ports, we require
  // the port to be explicitly in the pattern.
  const isDefaultHttps = port === 443;
  const testPrefixes = isDefaultHttps
    ? [`https://${hostname}/`]
    : [`https://${hostname}:${port}/`];

  // Also check http:// patterns (less common but possible)
  const isDefaultHttp = port === 80;
  if (isDefaultHttp) {
    testPrefixes.push(`http://${hostname}/`);
  }

  for (const cred of credentials) {
    for (const pattern of cred.urlPatterns) {
      // Quick check: does the pattern start with one of our hostname prefixes?
      // Patterns are globs like "https://api.xero.com/*" or "https://*.example.com/*"
      for (const prefix of testPrefixes) {
        if (pattern.startsWith(prefix)) {
          return true;
        }
      }

      // Handle wildcard subdomain patterns like "https://*.example.com/*"
      // Check if hostname could match the pattern's domain part
      if (pattern.includes('*')) {
        const testUrl = `https://${hostname}/test`;
        // Use a simplified pattern check — just test if the domain part matches
        const domainPattern = pattern.split('/').slice(0, 3).join('/') + '/*';
        if (matchUrlPattern(domainPattern, testUrl)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Match a full URL against credentials and return the matching credential.
 */
export function matchCredentialForUrl(
  url: string,
  credentials: LoadedCredentialConfig[],
): LoadedCredentialConfig | null {
  for (const cred of credentials) {
    for (const pattern of cred.urlPatterns) {
      if (matchUrlPattern(pattern, url)) {
        return cred;
      }
    }
  }
  return null;
}

/**
 * Check if a request method is allowed for a credential in the given permission mode.
 */
export function checkPermission(
  method: string,
  credential: LoadedCredentialConfig,
  permissionMode: PermissionMode,
): PermissionCheckResult {
  // Execute mode ('allow-all') and Ask mode ('ask') — allow everything
  // Only Explore mode ('safe') restricts methods
  if (permissionMode !== 'safe') {
    return { allowed: true };
  }

  // Explore mode: check credential's allowed methods
  const allowedMethods = credential.permissions?.explore?.methods ?? ['GET'];
  const upperMethod = method.toUpperCase();

  if (allowedMethods.map(m => m.toUpperCase()).includes(upperMethod)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Explore mode: ${upperMethod} requests are not allowed for ${credential.name}. ` +
      `Allowed methods: ${allowedMethods.join(', ')}. ` +
      `Switch to Execute mode to make ${upperMethod} requests.`,
  };
}

/**
 * Build auth headers for injection based on credential config and secret value.
 * Ported from auth-curl's buildAuthFlags, adapted for HTTP headers instead of curl flags.
 */
export function buildAuthHeaders(
  auth: CredentialAuthConfig,
  secretValue: string,
  url: string,
): { headers: InterceptedHeaders; url: string } {
  const headers: InterceptedHeaders = {};

  switch (auth.type) {
    case 'bearer': {
      const scheme = auth.scheme || 'Bearer';
      headers['Authorization'] = `${scheme} ${secretValue}`;
      break;
    }
    case 'header': {
      headers[auth.headerName] = secretValue;
      break;
    }
    case 'multi-header': {
      try {
        const parsed = JSON.parse(secretValue) as Record<string, string>;
        for (const [name, value] of Object.entries(parsed)) {
          headers[name] = value;
        }
      } catch {
        // Invalid JSON — skip
      }
      break;
    }
    case 'query': {
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}${auth.paramName}=${encodeURIComponent(secretValue)}`;
      break;
    }
    case 'basic': {
      try {
        const { username, password } = JSON.parse(secretValue);
        headers['Authorization'] = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
      } catch {
        // If not JSON, treat as user:pass
        headers['Authorization'] = `Basic ${Buffer.from(secretValue).toString('base64')}`;
      }
      break;
    }
    case 'oauth2': {
      headers['Authorization'] = `Bearer ${secretValue}`;
      break;
    }
  }

  return { headers, url };
}

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
 * Load the secret value for a credential from the encrypted store.
 * Ported from auth-curl's loadSecret.
 */
export async function loadSecret(
  workspaceId: string,
  slug: string,
  authType: CredentialAuthConfig['type'],
): Promise<string | null> {
  const { getCredentialManager } = await import('@craft-agent/shared/credentials');
  const manager = getCredentialManager();

  const storeType = authTypeToStoreType(authType);

  const cred = await manager.get({
    type: storeType as any,
    workspaceId,
    sourceId: `cred_${slug}`,
  });
  return cred?.value ?? null;
}

/**
 * Load OAuth token with automatic refresh if expired.
 * Ported from auth-curl's loadOAuthToken.
 */
export async function loadOAuthToken(
  workspaceId: string,
  slug: string,
  oauthConfig: OAuth2AuthConfig,
): Promise<string | null> {
  const { getCredentialManager } = await import('@craft-agent/shared/credentials');
  const manager = getCredentialManager();

  const tokenId = {
    type: 'source_oauth' as const,
    workspaceId,
    sourceId: `cred_${slug}`,
  };

  const stored = await manager.get(tokenId);
  if (!stored?.value) {
    return null;
  }

  // Check if token is expired (with 60s buffer)
  if (stored.expiresAt && Date.now() > stored.expiresAt - 60000) {
    if (!stored.refreshToken || !stored.clientId || !stored.clientSecret) {
      return null; // Can't refresh without these
    }

    const { refreshCredentialToken } = await import('@craft-agent/shared/credentials/oauth-flow');
    const result = await refreshCredentialToken(
      oauthConfig.tokenUrl,
      stored.refreshToken,
      stored.clientId,
      stored.clientSecret,
    );

    if (result.success && result.accessToken) {
      await manager.set(tokenId, {
        ...stored,
        value: result.accessToken,
        refreshToken: result.refreshToken || stored.refreshToken,
        expiresAt: result.expiresAt,
      });
      return result.accessToken;
    }

    return null;
  }

  return stored.value;
}

/**
 * Load secret for a credential, handling OAuth token refresh.
 * Convenience wrapper combining loadSecret and loadOAuthToken.
 */
export async function loadCredentialSecret(
  credential: LoadedCredentialConfig,
): Promise<string | null> {
  if (credential.auth.type === 'oauth2') {
    return loadOAuthToken(credential.workspaceId, credential.slug, credential.auth);
  }
  return loadSecret(credential.workspaceId, credential.slug, credential.auth.type);
}

/**
 * Fully intercept a request: match credential, check permissions, load secret, build headers.
 *
 * @param url - Full request URL
 * @param method - HTTP method
 * @param credentials - Loaded credential registry
 * @param permissionMode - Current session's permission mode
 * @returns InterceptionResult if credential matched and injected, null if no match
 * @throws Error if permission denied (with descriptive message)
 */
export async function interceptRequest(
  url: string,
  method: string,
  credentials: LoadedCredentialConfig[],
  permissionMode: PermissionMode,
): Promise<InterceptionResult | null> {
  // Match credential
  const credential = matchCredentialForUrl(url, credentials);
  if (!credential) return null;

  // Check permission
  const permCheck = checkPermission(method, credential, permissionMode);
  if (!permCheck.allowed) {
    throw new PermissionDeniedError(permCheck.reason ?? 'Permission denied');
  }

  // Load secret
  const secret = await loadCredentialSecret(credential);
  if (!secret) {
    // No secret stored — credential config exists but not authenticated
    return null;
  }

  // Build headers
  const { headers, url: modifiedUrl } = buildAuthHeaders(credential.auth, secret, url);

  return { headers, url: modifiedUrl, credential };
}

/**
 * Error thrown when a request is blocked by permission mode.
 */
export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}
