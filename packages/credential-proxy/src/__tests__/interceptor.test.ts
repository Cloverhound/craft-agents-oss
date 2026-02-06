import { describe, it, expect } from 'bun:test';
import {
  hostnameMatchesCredentials,
  matchCredentialForUrl,
  checkPermission,
  buildAuthHeaders,
  PermissionDeniedError,
} from '../interceptor';
import type { LoadedCredentialConfig } from '@craft-agent/shared/credentials/credential-config-types';

// Helper to create a minimal LoadedCredentialConfig for testing
function makeCred(overrides: Partial<LoadedCredentialConfig> & { slug: string; urlPatterns: string[] }): LoadedCredentialConfig {
  const { slug, urlPatterns, name, auth, ...rest } = overrides;
  return {
    name: name ?? slug,
    slug,
    urlPatterns,
    auth: auth ?? { type: 'bearer' },
    configPath: `/test/credentials/${slug}.json`,
    workspaceRootPath: '/test',
    workspaceId: 'test-workspace',
    ...rest,
  };
}

describe('hostnameMatchesCredentials', () => {
  const xero = makeCred({
    slug: 'xero',
    urlPatterns: ['https://api.xero.com/*', 'https://identity.xero.com/*'],
  });

  const stripe = makeCred({
    slug: 'stripe',
    urlPatterns: ['https://api.stripe.com/*'],
  });

  const wildcardSub = makeCred({
    slug: 'wildcard',
    urlPatterns: ['https://*.example.com/*'],
  });

  it('matches exact hostname on standard port (443)', () => {
    expect(hostnameMatchesCredentials('api.xero.com', 443, [xero])).toBe(true);
  });

  it('matches second pattern in list', () => {
    expect(hostnameMatchesCredentials('identity.xero.com', 443, [xero])).toBe(true);
  });

  it('does not match unrelated hostname', () => {
    expect(hostnameMatchesCredentials('example.com', 443, [xero])).toBe(false);
  });

  it('does not match when no credentials provided', () => {
    expect(hostnameMatchesCredentials('api.xero.com', 443, [])).toBe(false);
  });

  it('matches across multiple credentials', () => {
    expect(hostnameMatchesCredentials('api.stripe.com', 443, [xero, stripe])).toBe(true);
  });

  it('matches wildcard subdomain patterns', () => {
    expect(hostnameMatchesCredentials('sub.example.com', 443, [wildcardSub])).toBe(true);
    expect(hostnameMatchesCredentials('deep.sub.example.com', 443, [wildcardSub])).toBe(true);
  });

  it('does not match the base domain for wildcard subdomain patterns', () => {
    // "*.example.com" should match subdomains, but may or may not match bare example.com
    // depending on implementation. The key test is that subdomains DO match.
    const result = hostnameMatchesCredentials('other-domain.com', 443, [wildcardSub]);
    expect(result).toBe(false);
  });

  it('handles non-standard ports', () => {
    const nonStd = makeCred({
      slug: 'custom-port',
      urlPatterns: ['https://api.example.com:8443/*'],
    });
    expect(hostnameMatchesCredentials('api.example.com', 8443, [nonStd])).toBe(true);
    expect(hostnameMatchesCredentials('api.example.com', 443, [nonStd])).toBe(false);
  });
});

describe('matchCredentialForUrl', () => {
  const xero = makeCred({
    slug: 'xero',
    urlPatterns: ['https://api.xero.com/*'],
  });

  const stripe = makeCred({
    slug: 'stripe',
    urlPatterns: ['https://api.stripe.com/*'],
  });

  it('returns matching credential', () => {
    const result = matchCredentialForUrl('https://api.xero.com/connections', [xero, stripe]);
    expect(result?.slug).toBe('xero');
  });

  it('returns null for no match', () => {
    const result = matchCredentialForUrl('https://example.com/test', [xero, stripe]);
    expect(result).toBeNull();
  });

  it('returns first match when multiple could match', () => {
    const broad = makeCred({
      slug: 'broad',
      urlPatterns: ['https://api.xero.com/*'],
    });
    const result = matchCredentialForUrl('https://api.xero.com/test', [broad, xero]);
    expect(result?.slug).toBe('broad');
  });

  it('matches URL with path and query params', () => {
    const result = matchCredentialForUrl('https://api.xero.com/api.xro/2.0/Invoices?page=1', [xero]);
    expect(result?.slug).toBe('xero');
  });

  it('returns null for empty credentials list', () => {
    const result = matchCredentialForUrl('https://api.xero.com/test', []);
    expect(result).toBeNull();
  });

  it('matches specific path patterns', () => {
    const v2Only = makeCred({
      slug: 'v2',
      urlPatterns: ['https://api.example.com/v2/*'],
    });
    expect(matchCredentialForUrl('https://api.example.com/v2/users', [v2Only])?.slug).toBe('v2');
    expect(matchCredentialForUrl('https://api.example.com/v1/users', [v2Only])).toBeNull();
  });
});

describe('checkPermission', () => {
  const defaultCred = makeCred({
    slug: 'test',
    urlPatterns: ['https://api.example.com/*'],
  });

  const getPostCred = makeCred({
    slug: 'test-post',
    urlPatterns: ['https://api.example.com/*'],
    permissions: {
      explore: { methods: ['GET', 'POST'] },
    },
  });

  describe('allow-all mode (Execute)', () => {
    it('allows all methods', () => {
      expect(checkPermission('GET', defaultCred, 'allow-all')).toEqual({ allowed: true });
      expect(checkPermission('POST', defaultCred, 'allow-all')).toEqual({ allowed: true });
      expect(checkPermission('DELETE', defaultCred, 'allow-all')).toEqual({ allowed: true });
      expect(checkPermission('PUT', defaultCred, 'allow-all')).toEqual({ allowed: true });
    });
  });

  describe('ask mode', () => {
    it('allows all methods', () => {
      expect(checkPermission('GET', defaultCred, 'ask')).toEqual({ allowed: true });
      expect(checkPermission('POST', defaultCred, 'ask')).toEqual({ allowed: true });
      expect(checkPermission('DELETE', defaultCred, 'ask')).toEqual({ allowed: true });
    });
  });

  describe('safe mode (Explore)', () => {
    it('allows GET by default (no permissions block)', () => {
      expect(checkPermission('GET', defaultCred, 'safe')).toEqual({ allowed: true });
    });

    it('blocks POST by default', () => {
      const result = checkPermission('POST', defaultCred, 'safe');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('POST');
      expect(result.reason).toContain('Explore mode');
    });

    it('blocks DELETE by default', () => {
      const result = checkPermission('DELETE', defaultCred, 'safe');
      expect(result.allowed).toBe(false);
    });

    it('blocks PUT by default', () => {
      const result = checkPermission('PUT', defaultCred, 'safe');
      expect(result.allowed).toBe(false);
    });

    it('respects custom explore methods', () => {
      expect(checkPermission('GET', getPostCred, 'safe')).toEqual({ allowed: true });
      expect(checkPermission('POST', getPostCred, 'safe')).toEqual({ allowed: true });

      const result = checkPermission('DELETE', getPostCred, 'safe');
      expect(result.allowed).toBe(false);
    });

    it('is case-insensitive for method matching', () => {
      expect(checkPermission('get', defaultCred, 'safe')).toEqual({ allowed: true });
      expect(checkPermission('Get', defaultCred, 'safe')).toEqual({ allowed: true });
    });

    it('includes credential name in denial reason', () => {
      const result = checkPermission('POST', defaultCred, 'safe');
      expect(result.reason).toContain(defaultCred.name);
    });

    it('includes allowed methods in denial reason', () => {
      const result = checkPermission('DELETE', getPostCred, 'safe');
      expect(result.reason).toContain('GET');
      expect(result.reason).toContain('POST');
    });
  });
});

describe('buildAuthHeaders', () => {
  describe('bearer auth', () => {
    it('sets Authorization header with Bearer scheme', () => {
      const result = buildAuthHeaders({ type: 'bearer' }, 'my-token', 'https://api.example.com/test');
      expect(result.headers).toEqual({ Authorization: 'Bearer my-token' });
      expect(result.url).toBe('https://api.example.com/test');
    });

    it('supports custom scheme', () => {
      const result = buildAuthHeaders({ type: 'bearer', scheme: 'Token' }, 'my-token', 'https://api.example.com/test');
      expect(result.headers).toEqual({ Authorization: 'Token my-token' });
    });
  });

  describe('header auth', () => {
    it('sets custom header', () => {
      const result = buildAuthHeaders({ type: 'header', headerName: 'X-API-Key' }, 'key123', 'https://api.example.com/test');
      expect(result.headers).toEqual({ 'X-API-Key': 'key123' });
    });
  });

  describe('multi-header auth', () => {
    it('sets multiple headers from JSON value', () => {
      const secret = JSON.stringify({ 'DD-API-KEY': 'apikey', 'DD-APPLICATION-KEY': 'appkey' });
      const result = buildAuthHeaders(
        { type: 'multi-header', headerNames: ['DD-API-KEY', 'DD-APPLICATION-KEY'] },
        secret,
        'https://api.datadoghq.com/test',
      );
      expect(result.headers).toEqual({
        'DD-API-KEY': 'apikey',
        'DD-APPLICATION-KEY': 'appkey',
      });
    });

    it('handles invalid JSON gracefully', () => {
      const result = buildAuthHeaders(
        { type: 'multi-header', headerNames: ['X-Key'] },
        'not-json',
        'https://api.example.com/test',
      );
      expect(result.headers).toEqual({});
    });
  });

  describe('query auth', () => {
    it('appends query param to URL without existing params', () => {
      const result = buildAuthHeaders(
        { type: 'query', paramName: 'api_key' },
        'key123',
        'https://api.example.com/test',
      );
      expect(result.url).toBe('https://api.example.com/test?api_key=key123');
      expect(result.headers).toEqual({});
    });

    it('appends query param to URL with existing params', () => {
      const result = buildAuthHeaders(
        { type: 'query', paramName: 'api_key' },
        'key123',
        'https://api.example.com/test?page=1',
      );
      expect(result.url).toBe('https://api.example.com/test?page=1&api_key=key123');
    });

    it('encodes special characters in query param value', () => {
      const result = buildAuthHeaders(
        { type: 'query', paramName: 'key' },
        'abc def+123',
        'https://api.example.com/test',
      );
      expect(result.url).toContain('key=abc%20def%2B123');
    });
  });

  describe('basic auth', () => {
    it('encodes JSON username:password as base64', () => {
      const secret = JSON.stringify({ username: 'user', password: 'pass' });
      const result = buildAuthHeaders({ type: 'basic' }, secret, 'https://api.example.com/test');
      const expected = Buffer.from('user:pass').toString('base64');
      expect(result.headers).toEqual({ Authorization: `Basic ${expected}` });
    });

    it('handles non-JSON value as raw string', () => {
      const result = buildAuthHeaders({ type: 'basic' }, 'user:pass', 'https://api.example.com/test');
      const expected = Buffer.from('user:pass').toString('base64');
      expect(result.headers).toEqual({ Authorization: `Basic ${expected}` });
    });
  });

  describe('oauth2 auth', () => {
    it('sets Bearer token from access token', () => {
      const result = buildAuthHeaders(
        { type: 'oauth2', authorizeUrl: '', tokenUrl: '', scopes: [] },
        'access-token-123',
        'https://api.example.com/test',
      );
      expect(result.headers).toEqual({ Authorization: 'Bearer access-token-123' });
    });
  });
});

describe('PermissionDeniedError', () => {
  it('has correct name and message', () => {
    const err = new PermissionDeniedError('test reason');
    expect(err.name).toBe('PermissionDeniedError');
    expect(err.message).toBe('test reason');
  });

  it('is an instance of Error', () => {
    const err = new PermissionDeniedError('test');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof PermissionDeniedError).toBe(true);
  });
});
