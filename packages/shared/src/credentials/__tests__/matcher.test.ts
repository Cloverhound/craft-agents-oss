/**
 * Tests for credentials/matcher.ts
 *
 * Validates URL glob matching and credential lookup logic.
 */

import { describe, it, expect } from 'bun:test';
import { matchUrlPattern, matchCredential, findCredentialBySlug } from '../matcher.ts';
import type { LoadedCredentialConfig } from '../credential-config-types.ts';

function createLoadedConfig(
  overrides: Partial<LoadedCredentialConfig> = {}
): LoadedCredentialConfig {
  return {
    name: 'Test',
    slug: 'test',
    urlPatterns: ['https://api.test.com/*'],
    auth: { type: 'bearer' },
    configPath: '/test/credentials/test.json',
    workspaceRootPath: '/test',
    workspaceId: 'test',
    ...overrides,
  };
}

describe('matchUrlPattern', () => {
  describe('wildcard matching', () => {
    it('matches simple wildcard at end of path', () => {
      expect(matchUrlPattern('https://api.xero.com/*', 'https://api.xero.com/api/v2/Invoices')).toBe(true);
    });

    it('matches exact URL without wildcard', () => {
      expect(matchUrlPattern('https://api.xero.com/health', 'https://api.xero.com/health')).toBe(true);
    });

    it('does not match when domain differs', () => {
      expect(matchUrlPattern('https://api.xero.com/*', 'https://api.stripe.com/charges')).toBe(false);
    });

    it('matches wildcard in subdomain', () => {
      expect(matchUrlPattern('https://*.example.com/*', 'https://api.example.com/anything')).toBe(true);
      expect(matchUrlPattern('https://*.example.com/*', 'https://auth.example.com/token')).toBe(true);
    });

    it('does not match partial domain', () => {
      expect(matchUrlPattern('https://api.xero.com/*', 'https://api.xero.com.evil.com/steal')).toBe(false);
    });
  });

  describe('path-specific patterns', () => {
    it('matches scoped path patterns', () => {
      expect(matchUrlPattern('https://api.example.com/v2/*', 'https://api.example.com/v2/users')).toBe(true);
      expect(matchUrlPattern('https://api.example.com/v2/*', 'https://api.example.com/v1/users')).toBe(false);
    });

    it('matches deeply nested paths', () => {
      expect(matchUrlPattern('https://api.example.com/*', 'https://api.example.com/a/b/c/d/e')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('matches URL with query parameters', () => {
      expect(matchUrlPattern('https://api.xero.com/*', 'https://api.xero.com/Invoices?page=1&status=DRAFT')).toBe(true);
    });

    it('matches URL with fragments', () => {
      expect(matchUrlPattern('https://api.xero.com/*', 'https://api.xero.com/docs#section')).toBe(true);
    });

    it('is case-sensitive by default', () => {
      expect(matchUrlPattern('https://api.xero.com/*', 'https://API.XERO.COM/invoices')).toBe(false);
    });

    it('handles special regex characters in pattern safely', () => {
      // The pattern itself contains characters that are regex-special
      expect(matchUrlPattern('https://api.example.com/v2.0/*', 'https://api.example.com/v2.0/data')).toBe(true);
      // Dot should be escaped (literal), not match any character
      expect(matchUrlPattern('https://api.example.com/v2.0/*', 'https://api.example.com/v2X0/data')).toBe(false);
    });

    it('returns false for invalid regex pattern', () => {
      // This tests the catch block — should not throw
      expect(matchUrlPattern('[invalid', 'https://example.com')).toBe(false);
    });

    it('does not match empty URL', () => {
      expect(matchUrlPattern('https://api.xero.com/*', '')).toBe(false);
    });

    it('does not match empty pattern against URL', () => {
      expect(matchUrlPattern('', 'https://api.xero.com/test')).toBe(false);
    });
  });

  describe('protocol handling', () => {
    it('differentiates between http and https', () => {
      expect(matchUrlPattern('https://api.example.com/*', 'http://api.example.com/data')).toBe(false);
    });

    it('matches http patterns', () => {
      expect(matchUrlPattern('http://localhost:3000/*', 'http://localhost:3000/api/health')).toBe(true);
    });
  });
});

describe('matchCredential', () => {
  it('returns null for empty registry', () => {
    expect(matchCredential('https://api.xero.com/test', [])).toBeNull();
  });

  it('returns null when no patterns match', () => {
    const registry = [
      createLoadedConfig({ slug: 'xero', urlPatterns: ['https://api.xero.com/*'] }),
    ];
    expect(matchCredential('https://api.stripe.com/charges', registry)).toBeNull();
  });

  it('returns the matching credential', () => {
    const registry = [
      createLoadedConfig({ slug: 'xero', urlPatterns: ['https://api.xero.com/*'] }),
      createLoadedConfig({ slug: 'stripe', urlPatterns: ['https://api.stripe.com/*'] }),
    ];
    const result = matchCredential('https://api.stripe.com/charges', registry);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('stripe');
  });

  it('returns first match when multiple credentials match (first wins)', () => {
    const registry = [
      createLoadedConfig({ slug: 'specific', urlPatterns: ['https://api.example.com/v2/*'] }),
      createLoadedConfig({ slug: 'broad', urlPatterns: ['https://api.example.com/*'] }),
    ];
    const result = matchCredential('https://api.example.com/v2/users', registry);
    expect(result!.slug).toBe('specific');
  });

  it('matches against multiple URL patterns per credential', () => {
    const registry = [
      createLoadedConfig({
        slug: 'xero',
        urlPatterns: ['https://api.xero.com/*', 'https://identity.xero.com/*'],
      }),
    ];
    expect(matchCredential('https://identity.xero.com/connect/token', registry)!.slug).toBe('xero');
    expect(matchCredential('https://api.xero.com/api.xro/2.0/Invoices', registry)!.slug).toBe('xero');
  });
});

describe('findCredentialBySlug', () => {
  const registry = [
    createLoadedConfig({ slug: 'xero', name: 'Xero' }),
    createLoadedConfig({ slug: 'stripe', name: 'Stripe' }),
  ];

  it('finds credential by exact slug', () => {
    const result = findCredentialBySlug('xero', registry);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Xero');
  });

  it('returns null for non-existent slug', () => {
    expect(findCredentialBySlug('github', registry)).toBeNull();
  });

  it('returns null for empty registry', () => {
    expect(findCredentialBySlug('xero', [])).toBeNull();
  });

  it('is case-sensitive', () => {
    expect(findCredentialBySlug('Xero', registry)).toBeNull();
  });
});
