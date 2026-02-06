/**
 * auth-curl core logic
 *
 * Shared module for URL matching, secret loading, and auth flag building.
 * Used by both the CLI entry point and the credential test tool.
 */

import { homedir } from 'os';
import { join, basename } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import type {
  CredentialConfig,
  LoadedCredentialConfig,
  CredentialAuthConfig,
  OAuth2AuthConfig,
} from '@craft-agent/shared/credentials/credential-config-types';

// ============================================================
// Workspace and Registry Discovery
// ============================================================

/**
 * Find the active workspace root path.
 *
 * Looks for the workspace from (in order):
 * 1. CRAFT_WORKSPACE_ROOT env var (set by Craft Agent when spawning bash)
 * 2. First workspace in ~/.craft-agent/config.json
 */
export function findWorkspaceRootPath(): string | null {
  // Check env var first (set by Craft Agent)
  const envPath = process.env.CRAFT_WORKSPACE_ROOT;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // Fall back to reading config.json
  const configPath = join(homedir(), '.craft-agent', 'config.json');
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const workspaces = config.workspaces;
    if (Array.isArray(workspaces) && workspaces.length > 0) {
      // Use first workspace's root path
      const ws = workspaces[0];
      const rootPath = ws.rootPath || join(homedir(), '.craft-agent', 'workspaces', ws.id);
      if (existsSync(rootPath)) {
        return rootPath;
      }
    }
  } catch {
    // Ignore parse errors
  }

  return null;
}

/**
 * Load all credential configs from a workspace's credentials directory.
 */
export function loadRegistry(workspaceRootPath: string): LoadedCredentialConfig[] {
  const credDir = join(workspaceRootPath, 'credentials');
  if (!existsSync(credDir)) return [];

  const configs: LoadedCredentialConfig[] = [];
  const workspaceId = basename(workspaceRootPath);

  try {
    for (const file of readdirSync(credDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const configPath = join(credDir, file);
        const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as CredentialConfig;
        configs.push({
          ...raw,
          configPath,
          workspaceRootPath,
          workspaceId,
        });
      } catch {
        // Skip invalid configs
      }
    }
  } catch {
    // Skip unreadable directory
  }

  return configs;
}

/**
 * Match a URL against credential URL patterns.
 * Returns the first matching credential or null.
 */
export function matchUrl(url: string, registry: LoadedCredentialConfig[]): LoadedCredentialConfig | null {
  for (const cred of registry) {
    for (const pattern of cred.urlPatterns) {
      if (urlMatchesPattern(url, pattern)) {
        return cred;
      }
    }
  }
  return null;
}

/**
 * Simple glob matching for URL patterns.
 */
function urlMatchesPattern(url: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  try {
    return new RegExp(`^${regexStr}$`).test(url);
  } catch {
    return false;
  }
}

// ============================================================
// Auth Flag Building
// ============================================================

/**
 * Build curl auth flags based on credential config and secret value.
 *
 * @param auth - The auth config from credential config
 * @param secretValue - The raw secret value from encrypted store
 * @param url - The original URL (may be modified for query auth)
 * @returns Object with flags array and optionally modified URL
 */
export function buildAuthFlags(
  auth: CredentialAuthConfig,
  secretValue: string,
  url: string
): { flags: string[]; url: string } {
  const flags: string[] = [];

  switch (auth.type) {
    case 'bearer': {
      const scheme = auth.scheme || 'Bearer';
      flags.push('-H', `Authorization: ${scheme} ${secretValue}`);
      break;
    }
    case 'header': {
      flags.push('-H', `${auth.headerName}: ${secretValue}`);
      break;
    }
    case 'multi-header': {
      // secretValue is JSON { "Key1": "val1", "Key2": "val2" }
      try {
        const headers = JSON.parse(secretValue) as Record<string, string>;
        for (const [name, value] of Object.entries(headers)) {
          flags.push('-H', `${name}: ${value}`);
        }
      } catch {
        // If not valid JSON, skip
      }
      break;
    }
    case 'query': {
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}${auth.paramName}=${encodeURIComponent(secretValue)}`;
      break;
    }
    case 'basic': {
      // secretValue is JSON { "username": "...", "password": "..." }
      try {
        const { username, password } = JSON.parse(secretValue);
        flags.push('--user', `${username}:${password}`);
      } catch {
        // If not valid JSON, treat as user:pass string
        flags.push('--user', secretValue);
      }
      break;
    }
    case 'oauth2': {
      // OAuth tokens are injected as Bearer
      flags.push('-H', `Authorization: Bearer ${secretValue}`);
      break;
    }
  }

  return { flags, url };
}

// ============================================================
// Secret Loading
// ============================================================

/**
 * Load the secret value for a credential from the encrypted store.
 * Returns null if no secret is found.
 */
export async function loadSecret(
  workspaceId: string,
  slug: string,
  authType: CredentialAuthConfig['type']
): Promise<string | null> {
  const { getCredentialManager } = await import('@craft-agent/shared/credentials');

  const manager = getCredentialManager();

  if (authType === 'oauth2') {
    // Try OAuth token store
    const oauthCred = await manager.get({
      type: 'source_oauth',
      workspaceId,
      sourceId: `cred_${slug}`,
    });
    return oauthCred?.value ?? null;
  }

  // Try static credential store
  const cred = await manager.get({
    type: 'source_apikey',
    workspaceId,
    sourceId: `cred_${slug}`,
  });
  return cred?.value ?? null;
}

/**
 * Load OAuth token and handle refresh if needed.
 * Returns the access token or null.
 */
export async function loadOAuthToken(
  workspaceId: string,
  slug: string,
  oauthConfig: OAuth2AuthConfig
): Promise<string | null> {
  const { getCredentialManager } = await import('@craft-agent/shared/credentials');
  const manager = getCredentialManager();

  const tokenId = {
    type: 'source_oauth' as const,
    workspaceId,
    sourceId: `cred_${slug}`,
  };

  const stored = await manager.get(tokenId);
  if (!stored?.value) return null;

  // Check if token is expired (with 60s buffer)
  if (stored.expiresAt && Date.now() > stored.expiresAt - 60000) {
    // Need to refresh
    if (!stored.refreshToken || !stored.clientId || !stored.clientSecret) {
      return null; // Can't refresh without these
    }

    const { refreshCredentialToken } = await import('@craft-agent/shared/credentials/oauth-flow');
    const result = await refreshCredentialToken(
      oauthConfig.tokenUrl,
      stored.refreshToken,
      stored.clientId,
      stored.clientSecret
    );

    if (result.success && result.accessToken) {
      // Update stored token
      await manager.set(tokenId, {
        ...stored,
        value: result.accessToken,
        refreshToken: result.refreshToken || stored.refreshToken,
        expiresAt: result.expiresAt,
      });
      return result.accessToken;
    }

    return null; // Refresh failed
  }

  return stored.value;
}
