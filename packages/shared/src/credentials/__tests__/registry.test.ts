/**
 * Tests for credentials/registry.ts
 *
 * Validates loading, saving, deleting, and listing credential configs
 * from the workspace credentials directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import {
  getCredentialsDir,
  getCredentialConfigPath,
  loadCredentialConfig,
  loadCredentialRegistry,
  saveCredentialConfig,
  deleteCredentialConfig,
  listCredentialSlugs,
} from '../registry.ts';
import type { CredentialConfig } from '../credential-config-types.ts';

const TEST_ROOT = join(import.meta.dir, '__test-workspace-registry__');
const CRED_DIR = join(TEST_ROOT, 'credentials');

function createTestConfig(overrides: Partial<CredentialConfig> = {}): CredentialConfig {
  return {
    name: 'Test API',
    slug: 'test-api',
    urlPatterns: ['https://api.test.com/*'],
    auth: { type: 'bearer' },
    ...overrides,
  };
}

describe('Credential Registry', () => {
  beforeEach(() => {
    // Clean slate
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true });
    }
    mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true });
    }
  });

  describe('getCredentialsDir', () => {
    it('returns the credentials subdirectory path', () => {
      expect(getCredentialsDir('/workspace/root')).toBe('/workspace/root/credentials');
    });
  });

  describe('getCredentialConfigPath', () => {
    it('returns the path for a specific credential config file', () => {
      expect(getCredentialConfigPath('/workspace/root', 'xero')).toBe(
        '/workspace/root/credentials/xero.json'
      );
    });
  });

  describe('loadCredentialConfig', () => {
    it('returns null for non-existent credential', () => {
      const result = loadCredentialConfig(TEST_ROOT, 'nonexistent');
      expect(result).toBeNull();
    });

    it('loads a valid credential config', () => {
      mkdirSync(CRED_DIR, { recursive: true });
      const config = createTestConfig();
      writeFileSync(join(CRED_DIR, 'test-api.json'), JSON.stringify(config));

      const result = loadCredentialConfig(TEST_ROOT, 'test-api');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Test API');
      expect(result!.slug).toBe('test-api');
      expect(result!.urlPatterns).toEqual(['https://api.test.com/*']);
      expect(result!.auth).toEqual({ type: 'bearer' });
    });

    it('includes workspace context in loaded config', () => {
      mkdirSync(CRED_DIR, { recursive: true });
      writeFileSync(join(CRED_DIR, 'xero.json'), JSON.stringify(createTestConfig({ slug: 'xero' })));

      const result = loadCredentialConfig(TEST_ROOT, 'xero');
      expect(result!.configPath).toBe(join(CRED_DIR, 'xero.json'));
      expect(result!.workspaceRootPath).toBe(TEST_ROOT);
      expect(result!.workspaceId).toBeTruthy();
    });

    it('returns null for invalid JSON', () => {
      mkdirSync(CRED_DIR, { recursive: true });
      writeFileSync(join(CRED_DIR, 'broken.json'), 'not valid json{{{');

      const result = loadCredentialConfig(TEST_ROOT, 'broken');
      expect(result).toBeNull();
    });
  });

  describe('loadCredentialRegistry', () => {
    it('returns empty array when credentials dir does not exist', () => {
      const result = loadCredentialRegistry(TEST_ROOT);
      expect(result).toEqual([]);
    });

    it('loads all credential configs from directory', () => {
      mkdirSync(CRED_DIR, { recursive: true });
      writeFileSync(
        join(CRED_DIR, 'xero.json'),
        JSON.stringify(createTestConfig({ slug: 'xero', name: 'Xero' }))
      );
      writeFileSync(
        join(CRED_DIR, 'stripe.json'),
        JSON.stringify(createTestConfig({ slug: 'stripe', name: 'Stripe' }))
      );

      const result = loadCredentialRegistry(TEST_ROOT);
      expect(result).toHaveLength(2);
      const slugs = result.map((c) => c.slug).sort();
      expect(slugs).toEqual(['stripe', 'xero']);
    });

    it('skips non-JSON files', () => {
      mkdirSync(CRED_DIR, { recursive: true });
      writeFileSync(
        join(CRED_DIR, 'valid.json'),
        JSON.stringify(createTestConfig({ slug: 'valid' }))
      );
      writeFileSync(join(CRED_DIR, 'readme.md'), '# Credentials');
      writeFileSync(join(CRED_DIR, '.gitkeep'), '');

      const result = loadCredentialRegistry(TEST_ROOT);
      expect(result).toHaveLength(1);
      expect(result[0]!.slug).toBe('valid');
    });

    it('skips invalid JSON files gracefully', () => {
      mkdirSync(CRED_DIR, { recursive: true });
      writeFileSync(
        join(CRED_DIR, 'valid.json'),
        JSON.stringify(createTestConfig({ slug: 'valid' }))
      );
      writeFileSync(join(CRED_DIR, 'broken.json'), '{invalid');

      const result = loadCredentialRegistry(TEST_ROOT);
      expect(result).toHaveLength(1);
      expect(result[0]!.slug).toBe('valid');
    });
  });

  describe('saveCredentialConfig', () => {
    it('creates credentials directory if it does not exist', () => {
      expect(existsSync(CRED_DIR)).toBe(false);
      saveCredentialConfig(TEST_ROOT, createTestConfig());
      expect(existsSync(CRED_DIR)).toBe(true);
    });

    it('saves config as formatted JSON', () => {
      saveCredentialConfig(TEST_ROOT, createTestConfig({ slug: 'xero' }));

      const raw = readFileSync(join(CRED_DIR, 'xero.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.slug).toBe('xero');
      expect(parsed.name).toBe('Test API');
      // Should be formatted (multi-line) with trailing newline
      expect(raw).toContain('\n');
      expect(raw.endsWith('\n')).toBe(true);
    });

    it('overwrites existing config', () => {
      saveCredentialConfig(TEST_ROOT, createTestConfig({ slug: 'xero', name: 'Xero v1' }));
      saveCredentialConfig(TEST_ROOT, createTestConfig({ slug: 'xero', name: 'Xero v2' }));

      const result = loadCredentialConfig(TEST_ROOT, 'xero');
      expect(result!.name).toBe('Xero v2');
    });

    it('preserves all config fields', () => {
      const fullConfig: CredentialConfig = {
        name: 'Full Config',
        slug: 'full',
        urlPatterns: ['https://api.example.com/*', 'https://auth.example.com/*'],
        auth: {
          type: 'oauth2',
          authorizeUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
          scopes: ['read', 'write'],
          callbackPort: 9876,
        },
        icon: 'https://example.com/icon.png',
        description: 'Example API',
        permissions: { explore: { methods: ['GET'], comment: 'Read-only' } },
        testRequest: { url: 'https://api.example.com/me', method: 'GET' },
        isAuthenticated: true,
        lastTestedAt: 1700000000000,
      };

      saveCredentialConfig(TEST_ROOT, fullConfig);
      const loaded = loadCredentialConfig(TEST_ROOT, 'full');
      expect(loaded!.name).toBe('Full Config');
      expect(loaded!.auth).toEqual(fullConfig.auth);
      expect(loaded!.permissions).toEqual(fullConfig.permissions);
      expect(loaded!.testRequest).toEqual(fullConfig.testRequest);
      expect(loaded!.isAuthenticated).toBe(true);
      expect(loaded!.lastTestedAt).toBe(1700000000000);
    });
  });

  describe('deleteCredentialConfig', () => {
    it('returns false for non-existent credential', () => {
      const result = deleteCredentialConfig(TEST_ROOT, 'nonexistent');
      expect(result).toBe(false);
    });

    it('deletes existing credential config', () => {
      mkdirSync(CRED_DIR, { recursive: true });
      writeFileSync(join(CRED_DIR, 'xero.json'), JSON.stringify(createTestConfig()));

      expect(existsSync(join(CRED_DIR, 'xero.json'))).toBe(true);
      const result = deleteCredentialConfig(TEST_ROOT, 'xero');
      expect(result).toBe(true);
      expect(existsSync(join(CRED_DIR, 'xero.json'))).toBe(false);
    });
  });

  describe('listCredentialSlugs', () => {
    it('returns empty array when credentials dir does not exist', () => {
      const result = listCredentialSlugs(TEST_ROOT);
      expect(result).toEqual([]);
    });

    it('lists all credential slugs', () => {
      mkdirSync(CRED_DIR, { recursive: true });
      writeFileSync(join(CRED_DIR, 'xero.json'), '{}');
      writeFileSync(join(CRED_DIR, 'stripe.json'), '{}');
      writeFileSync(join(CRED_DIR, 'readme.md'), 'not a credential');

      const result = listCredentialSlugs(TEST_ROOT);
      expect(result.sort()).toEqual(['stripe', 'xero']);
    });
  });
});
