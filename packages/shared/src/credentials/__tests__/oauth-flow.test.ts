/**
 * Tests for credentials/oauth-flow.ts
 *
 * Tests the OAuth 2.0 + PKCE flow components:
 * - Token refresh logic (with mocked fetch)
 * - Callback server lifecycle
 * - PKCE generation (indirectly via the flow)
 *
 * The full browser-based flow is hard to test in unit tests,
 * so we focus on the refresh function and error handling.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { refreshCredentialToken } from '../oauth-flow.ts';

// Save original fetch for restoration
const originalFetch = globalThis.fetch;

describe('OAuth Flow', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ============================================================
  // refreshCredentialToken
  // ============================================================

  describe('refreshCredentialToken', () => {
    it('successfully refreshes a token', async () => {
      const mockFetch = mock(async () => new Response(
        JSON.stringify({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ));
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const result = await refreshCredentialToken(
        'https://identity.xero.com/connect/token',
        'old-refresh-token',
        'client-id-123',
        'client-secret-456'
      );

      expect(result.success).toBe(true);
      expect(result.accessToken).toBe('new-access-token');
      expect(result.refreshToken).toBe('new-refresh-token');
      expect(result.expiresAt).toBeGreaterThan(Date.now());

      // Verify the fetch was called correctly
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = (mockFetch.mock.calls as any[][])[0]! as [string, RequestInit];
      expect(url).toBe('https://identity.xero.com/connect/token');
      expect(options.method).toBe('POST');
      expect(options.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });

      const body = options.body as string;
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=old-refresh-token');
      expect(body).toContain('client_id=client-id-123');
      expect(body).toContain('client_secret=client-secret-456');
    });

    it('uses original refresh token when response does not include new one', async () => {
      const mockFetch = mock(async () => new Response(
        JSON.stringify({
          access_token: 'new-access-token',
          // No refresh_token in response
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ));
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const result = await refreshCredentialToken(
        'https://token.example.com',
        'original-refresh-token',
        'cid',
        'csecret'
      );

      expect(result.success).toBe(true);
      expect(result.refreshToken).toBe('original-refresh-token');
    });

    it('handles missing expires_in gracefully', async () => {
      const mockFetch = mock(async () => new Response(
        JSON.stringify({
          access_token: 'new-access-token',
          // No expires_in
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ));
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const result = await refreshCredentialToken(
        'https://token.example.com',
        'rt',
        'cid',
        'csecret'
      );

      expect(result.success).toBe(true);
      expect(result.expiresAt).toBeUndefined();
    });

    it('returns error on HTTP failure', async () => {
      const mockFetch = mock(async () => new Response(
        'Invalid grant',
        { status: 400 }
      ));
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const result = await refreshCredentialToken(
        'https://token.example.com',
        'expired-refresh-token',
        'cid',
        'csecret'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Token refresh failed');
      expect(result.error).toContain('400');
    });

    it('returns error on network failure', async () => {
      const mockFetch = mock(async () => {
        throw new Error('Network error: DNS resolution failed');
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const result = await refreshCredentialToken(
        'https://unreachable.example.com/token',
        'rt',
        'cid',
        'csecret'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Token refresh failed');
      expect(result.error).toContain('DNS resolution failed');
    });

    it('returns error on non-Error thrown exception', async () => {
      const mockFetch = mock(async () => {
        throw 'string error';
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const result = await refreshCredentialToken(
        'https://token.example.com',
        'rt',
        'cid',
        'csecret'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('string error');
    });
  });
});
