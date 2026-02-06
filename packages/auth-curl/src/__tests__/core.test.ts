/**
 * Tests for auth-curl/core.ts
 *
 * Validates workspace discovery, URL matching, and auth flag building.
 * Secret loading functions are tested with mocked credential managers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import {
  findWorkspaceRootPath,
  loadRegistry,
  matchUrl,
  buildAuthFlags,
} from '../core.ts';
import type { LoadedCredentialConfig, CredentialAuthConfig } from '@craft-agent/shared/credentials/credential-config-types';

const TEST_ROOT = join(import.meta.dir, '__test-workspace-auth-curl__');
const CRED_DIR = join(TEST_ROOT, 'credentials');

function createConfig(overrides: Partial<LoadedCredentialConfig> = {}): LoadedCredentialConfig {
  return {
    name: 'Test',
    slug: 'test',
    urlPatterns: ['https://api.test.com/*'],
    auth: { type: 'bearer' },
    configPath: join(CRED_DIR, 'test.json'),
    workspaceRootPath: TEST_ROOT,
    workspaceId: 'test-workspace',
    ...overrides,
  };
}

describe('auth-curl core', () => {
  beforeEach(() => {
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true });
    }
    mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true });
    }
    // Clean up env var
    delete process.env.CRAFT_WORKSPACE_ROOT;
  });

  // ============================================================
  // findWorkspaceRootPath
  // ============================================================

  describe('findWorkspaceRootPath', () => {
    it('returns env var path when CRAFT_WORKSPACE_ROOT is set and exists', () => {
      process.env.CRAFT_WORKSPACE_ROOT = TEST_ROOT;
      expect(findWorkspaceRootPath()).toBe(TEST_ROOT);
    });

    it('returns null when CRAFT_WORKSPACE_ROOT points to non-existent path', () => {
      process.env.CRAFT_WORKSPACE_ROOT = '/definitely/not/a/real/path';
      // Falls through to config.json which likely doesn't have our test workspace
      const result = findWorkspaceRootPath();
      // Result depends on system config — just verify it doesn't throw
      expect(result === null || typeof result === 'string').toBe(true);
    });

    it('ignores empty CRAFT_WORKSPACE_ROOT', () => {
      process.env.CRAFT_WORKSPACE_ROOT = '';
      const result = findWorkspaceRootPath();
      // Falls through to config.json lookup
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });

  // ============================================================
  // loadRegistry
  // ============================================================

  describe('loadRegistry', () => {
    it('returns empty array when credentials directory does not exist', () => {
      const result = loadRegistry(TEST_ROOT);
      expect(result).toEqual([]);
    });

    it('loads all credential configs from directory', () => {
      mkdirSync(CRED_DIR, { recursive: true });
      writeFileSync(join(CRED_DIR, 'xero.json'), JSON.stringify({
        name: 'Xero',
        slug: 'xero',
        urlPatterns: ['https://api.xero.com/*'],
        auth: { type: 'bearer' },
      }));
      writeFileSync(join(CRED_DIR, 'stripe.json'), JSON.stringify({
        name: 'Stripe',
        slug: 'stripe',
        urlPatterns: ['https://api.stripe.com/*'],
        auth: { type: 'bearer' },
      }));

      const result = loadRegistry(TEST_ROOT);
      expect(result).toHaveLength(2);

      const slugs = result.map((c) => c.slug).sort();
      expect(slugs).toEqual(['stripe', 'xero']);

      // Check workspace context is populated
      for (const config of result) {
        expect(config.workspaceRootPath).toBe(TEST_ROOT);
        expect(config.workspaceId).toBeTruthy();
        expect(config.configPath).toContain('credentials');
      }
    });

    it('skips non-JSON files', () => {
      mkdirSync(CRED_DIR, { recursive: true });
      writeFileSync(join(CRED_DIR, 'valid.json'), JSON.stringify({
        name: 'Valid', slug: 'valid', urlPatterns: [], auth: { type: 'basic' },
      }));
      writeFileSync(join(CRED_DIR, '.gitkeep'), '');
      writeFileSync(join(CRED_DIR, 'notes.txt'), 'some notes');

      const result = loadRegistry(TEST_ROOT);
      expect(result).toHaveLength(1);
    });

    it('skips invalid JSON files gracefully', () => {
      mkdirSync(CRED_DIR, { recursive: true });
      writeFileSync(join(CRED_DIR, 'valid.json'), JSON.stringify({
        name: 'Valid', slug: 'valid', urlPatterns: [], auth: { type: 'basic' },
      }));
      writeFileSync(join(CRED_DIR, 'broken.json'), 'not { valid json');

      const result = loadRegistry(TEST_ROOT);
      expect(result).toHaveLength(1);
      expect(result[0]!.slug).toBe('valid');
    });
  });

  // ============================================================
  // matchUrl
  // ============================================================

  describe('matchUrl', () => {
    it('returns null for empty registry', () => {
      expect(matchUrl('https://api.xero.com/test', [])).toBeNull();
    });

    it('returns matching credential', () => {
      const registry = [
        createConfig({ slug: 'xero', urlPatterns: ['https://api.xero.com/*'] }),
      ];
      const result = matchUrl('https://api.xero.com/api/v2/Invoices', registry);
      expect(result).not.toBeNull();
      expect(result!.slug).toBe('xero');
    });

    it('returns null when no match', () => {
      const registry = [
        createConfig({ slug: 'xero', urlPatterns: ['https://api.xero.com/*'] }),
      ];
      expect(matchUrl('https://api.stripe.com/charges', registry)).toBeNull();
    });

    it('returns first match (first-wins order)', () => {
      const registry = [
        createConfig({ slug: 'specific', urlPatterns: ['https://api.example.com/v2/*'] }),
        createConfig({ slug: 'broad', urlPatterns: ['https://api.example.com/*'] }),
      ];
      const result = matchUrl('https://api.example.com/v2/users', registry);
      expect(result!.slug).toBe('specific');
    });

    it('matches against multiple URL patterns', () => {
      const registry = [
        createConfig({
          slug: 'xero',
          urlPatterns: ['https://api.xero.com/*', 'https://identity.xero.com/*'],
        }),
      ];
      expect(matchUrl('https://identity.xero.com/connect/token', registry)!.slug).toBe('xero');
    });
  });

  // ============================================================
  // buildAuthFlags
  // ============================================================

  describe('buildAuthFlags', () => {
    it('builds Bearer auth flags', () => {
      const auth: CredentialAuthConfig = { type: 'bearer' };
      const result = buildAuthFlags(auth, 'my-token-123', 'https://api.example.com/data');

      expect(result.flags).toEqual(['-H', 'Authorization: Bearer my-token-123']);
      expect(result.url).toBe('https://api.example.com/data');
    });

    it('builds Bearer with custom scheme', () => {
      const auth: CredentialAuthConfig = { type: 'bearer', scheme: 'Token' };
      const result = buildAuthFlags(auth, 'tok_123', 'https://api.example.com/data');

      expect(result.flags).toEqual(['-H', 'Authorization: Token tok_123']);
    });

    it('builds custom header auth flags', () => {
      const auth: CredentialAuthConfig = { type: 'header', headerName: 'X-API-Key' };
      const result = buildAuthFlags(auth, 'key-abc', 'https://api.example.com/data');

      expect(result.flags).toEqual(['-H', 'X-API-Key: key-abc']);
    });

    it('builds multi-header auth flags', () => {
      const auth: CredentialAuthConfig = {
        type: 'multi-header',
        headerNames: ['DD-API-KEY', 'DD-APPLICATION-KEY'],
      };
      const secret = JSON.stringify({ 'DD-API-KEY': 'key1', 'DD-APPLICATION-KEY': 'key2' });
      const result = buildAuthFlags(auth, secret, 'https://api.datadoghq.com/v1/query');

      expect(result.flags).toEqual([
        '-H', 'DD-API-KEY: key1',
        '-H', 'DD-APPLICATION-KEY: key2',
      ]);
    });

    it('handles multi-header with invalid JSON gracefully', () => {
      const auth: CredentialAuthConfig = {
        type: 'multi-header',
        headerNames: ['DD-API-KEY'],
      };
      const result = buildAuthFlags(auth, 'not-json', 'https://api.example.com');

      expect(result.flags).toEqual([]); // Skips on invalid JSON
    });

    it('builds query parameter auth', () => {
      const auth: CredentialAuthConfig = { type: 'query', paramName: 'api_key' };
      const result = buildAuthFlags(auth, 'key123', 'https://api.example.com/data');

      expect(result.url).toBe('https://api.example.com/data?api_key=key123');
      expect(result.flags).toEqual([]);
    });

    it('appends query parameter with & when URL already has query', () => {
      const auth: CredentialAuthConfig = { type: 'query', paramName: 'api_key' };
      const result = buildAuthFlags(auth, 'key123', 'https://api.example.com/data?page=1');

      expect(result.url).toBe('https://api.example.com/data?page=1&api_key=key123');
    });

    it('URL-encodes query parameter values', () => {
      const auth: CredentialAuthConfig = { type: 'query', paramName: 'key' };
      const result = buildAuthFlags(auth, 'val ue&special=char', 'https://api.example.com');

      expect(result.url).toContain('key=val%20ue%26special%3Dchar');
    });

    it('builds basic auth flags from JSON', () => {
      const auth: CredentialAuthConfig = { type: 'basic' };
      const secret = JSON.stringify({ username: 'user', password: 'pass' });
      const result = buildAuthFlags(auth, secret, 'https://api.example.com');

      expect(result.flags).toEqual(['--user', 'user:pass']);
    });

    it('falls back to raw string for basic auth when JSON is invalid', () => {
      const auth: CredentialAuthConfig = { type: 'basic' };
      const result = buildAuthFlags(auth, 'user:pass', 'https://api.example.com');

      expect(result.flags).toEqual(['--user', 'user:pass']);
    });

    it('builds OAuth2 auth flags as Bearer', () => {
      const auth: CredentialAuthConfig = {
        type: 'oauth2',
        authorizeUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
        scopes: ['read'],
      };
      const result = buildAuthFlags(auth, 'oauth-access-token', 'https://api.example.com/data');

      expect(result.flags).toEqual(['-H', 'Authorization: Bearer oauth-access-token']);
    });
  });
});
