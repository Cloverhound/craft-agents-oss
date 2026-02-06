/**
 * Tests for credentials/credential-config-types.ts
 *
 * Validates that credential config type definitions work correctly
 * at runtime when used to create, serialize, and deserialize configs.
 */

import { describe, it, expect } from 'bun:test';
import type {
  CredentialConfig,
  CredentialAuthConfig,
  BearerAuthConfig,
  HeaderAuthConfig,
  MultiHeaderAuthConfig,
  QueryAuthConfig,
  BasicAuthConfig,
  OAuth2AuthConfig,
  LoadedCredentialConfig,
} from '../credential-config-types.ts';

describe('Credential Config Types', () => {
  describe('auth type variants', () => {
    it('BearerAuthConfig with default scheme', () => {
      const auth: BearerAuthConfig = { type: 'bearer' };
      expect(auth.type).toBe('bearer');
      expect(auth.scheme).toBeUndefined();
    });

    it('BearerAuthConfig with custom scheme', () => {
      const auth: BearerAuthConfig = { type: 'bearer', scheme: 'Token' };
      expect(auth.scheme).toBe('Token');
    });

    it('HeaderAuthConfig', () => {
      const auth: HeaderAuthConfig = { type: 'header', headerName: 'X-API-Key' };
      expect(auth.type).toBe('header');
      expect(auth.headerName).toBe('X-API-Key');
    });

    it('MultiHeaderAuthConfig', () => {
      const auth: MultiHeaderAuthConfig = {
        type: 'multi-header',
        headerNames: ['DD-API-KEY', 'DD-APPLICATION-KEY'],
      };
      expect(auth.type).toBe('multi-header');
      expect(auth.headerNames).toHaveLength(2);
    });

    it('QueryAuthConfig', () => {
      const auth: QueryAuthConfig = { type: 'query', paramName: 'api_key' };
      expect(auth.type).toBe('query');
      expect(auth.paramName).toBe('api_key');
    });

    it('BasicAuthConfig', () => {
      const auth: BasicAuthConfig = { type: 'basic' };
      expect(auth.type).toBe('basic');
    });

    it('OAuth2AuthConfig', () => {
      const auth: OAuth2AuthConfig = {
        type: 'oauth2',
        authorizeUrl: 'https://login.xero.com/authorize',
        tokenUrl: 'https://identity.xero.com/token',
        scopes: ['openid', 'accounting.transactions'],
        callbackPort: 9876,
      };
      expect(auth.type).toBe('oauth2');
      expect(auth.scopes).toHaveLength(2);
      expect(auth.callbackPort).toBe(9876);
    });

    it('OAuth2AuthConfig without optional callbackPort', () => {
      const auth: OAuth2AuthConfig = {
        type: 'oauth2',
        authorizeUrl: 'https://example.com/authorize',
        tokenUrl: 'https://example.com/token',
        scopes: ['read'],
      };
      expect(auth.callbackPort).toBeUndefined();
    });
  });

  describe('CredentialAuthConfig union', () => {
    it('discriminates by type field', () => {
      const configs: CredentialAuthConfig[] = [
        { type: 'bearer' },
        { type: 'header', headerName: 'X-Key' },
        { type: 'multi-header', headerNames: ['A', 'B'] },
        { type: 'query', paramName: 'key' },
        { type: 'basic' },
        { type: 'oauth2', authorizeUrl: 'https://a.com', tokenUrl: 'https://t.com', scopes: [] },
      ];

      const types = configs.map((c) => c.type);
      expect(types).toEqual(['bearer', 'header', 'multi-header', 'query', 'basic', 'oauth2']);
    });
  });

  describe('CredentialConfig', () => {
    it('serializes and deserializes via JSON round-trip', () => {
      const config: CredentialConfig = {
        name: 'Xero',
        slug: 'xero',
        urlPatterns: ['https://api.xero.com/*'],
        auth: { type: 'bearer' },
        icon: 'https://www.xero.com/favicon.ico',
        description: 'Xero accounting API',
        permissions: { explore: { methods: ['GET'], comment: 'Read-only' } },
        testRequest: { url: 'https://api.xero.com/api.xro/2.0/Organisation', method: 'GET' },
        isAuthenticated: true,
        lastTestedAt: 1700000000000,
      };

      const json = JSON.stringify(config);
      const parsed: CredentialConfig = JSON.parse(json);

      expect(parsed.name).toBe('Xero');
      expect(parsed.slug).toBe('xero');
      expect(parsed.urlPatterns).toEqual(['https://api.xero.com/*']);
      expect(parsed.auth.type).toBe('bearer');
      expect(parsed.permissions?.explore?.methods).toEqual(['GET']);
      expect(parsed.testRequest?.url).toBe('https://api.xero.com/api.xro/2.0/Organisation');
      expect(parsed.isAuthenticated).toBe(true);
      expect(parsed.lastTestedAt).toBe(1700000000000);
    });

    it('handles minimal config (required fields only)', () => {
      const config: CredentialConfig = {
        name: 'Minimal',
        slug: 'minimal',
        urlPatterns: [],
        auth: { type: 'basic' },
      };

      expect(config.icon).toBeUndefined();
      expect(config.description).toBeUndefined();
      expect(config.permissions).toBeUndefined();
      expect(config.testRequest).toBeUndefined();
      expect(config.isAuthenticated).toBeUndefined();
      expect(config.lastTestedAt).toBeUndefined();
    });
  });

  describe('LoadedCredentialConfig', () => {
    it('extends CredentialConfig with workspace context', () => {
      const loaded: LoadedCredentialConfig = {
        name: 'Stripe',
        slug: 'stripe',
        urlPatterns: ['https://api.stripe.com/*'],
        auth: { type: 'bearer' },
        configPath: '/home/user/.craft-agent/workspaces/ws1/credentials/stripe.json',
        workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
        workspaceId: 'ws1',
      };

      expect(loaded.configPath).toContain('stripe.json');
      expect(loaded.workspaceRootPath).toContain('ws1');
      expect(loaded.workspaceId).toBe('ws1');
    });
  });
});
