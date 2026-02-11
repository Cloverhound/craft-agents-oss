/**
 * Tests for proxy configuration in getDefaultOptions().
 *
 * Verifies the proxy URL format, env vars, and NO_PROXY bypass rules
 * that are injected into the SDK subprocess environment.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setProxyConfig, clearProxyConfig, getDefaultOptions, getCredentialProxyEnv } from '../options';

// Env vars that the proxy config injects — must be saved/restored so that
// a live Craft Agent session (which sets HTTP_PROXY etc.) doesn't leak into tests.
const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'NODE_USE_ENV_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
] as const;

describe('getDefaultOptions proxy config', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear proxy-related env vars to isolate tests from live environment
    for (const key of PROXY_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    clearProxyConfig();
    // Restore original env vars
    for (const key of PROXY_ENV_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('includes no proxy env vars when proxy is not configured', () => {
    clearProxyConfig();
    const opts = getDefaultOptions();
    const env = opts.env ?? {};

    // Proxy env vars should not be present (beyond whatever process.env has)
    // Check that we didn't inject our own proxy values
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  it('generates proxy URL with user:pass format (Bun compat)', () => {
    setProxyConfig({
      sessionId: 'abc-123',
      port: 9999,
      caCertPath: '/tmp/ca.crt',
      caBundlePath: '/tmp/ca-bundle.pem',
    });

    const opts = getDefaultOptions();
    const env = opts.env!;

    // Must be user:pass@host — Bun's fetch rejects user-only URLs
    expect(env.HTTP_PROXY).toBe('http://session-abc-123:session@127.0.0.1:9999');
    expect(env.HTTPS_PROXY).toBe('http://session-abc-123:session@127.0.0.1:9999');
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
  });

  it('proxy URL is parseable and contains expected components', () => {
    setProxyConfig({
      sessionId: 'test-sess',
      port: 12345,
      caCertPath: '/tmp/ca.crt',
      caBundlePath: null,
    });

    const opts = getDefaultOptions();
    const url = new URL(opts.env!.HTTPS_PROXY!);

    expect(url.protocol).toBe('http:');
    expect(url.username).toBe('session-test-sess');
    expect(url.password).toBe('session');
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toBe('12345');
  });

  it('sets NO_PROXY to bypass localhost and Anthropic domains', () => {
    setProxyConfig({
      sessionId: 'test',
      port: 8000,
      caCertPath: '/tmp/ca.crt',
      caBundlePath: null,
    });

    const opts = getDefaultOptions();
    const noProxy = opts.env!.NO_PROXY!;

    expect(noProxy).toContain('localhost');
    expect(noProxy).toContain('127.0.0.1');
    expect(noProxy).toContain('::1');
    expect(noProxy).toContain('.anthropic.com');
    expect(noProxy).toContain('.claude.ai');
  });

  it('sets NODE_EXTRA_CA_CERTS to CA cert path', () => {
    setProxyConfig({
      sessionId: 'test',
      port: 8000,
      caCertPath: '/tmp/test-ca.crt',
      caBundlePath: null,
    });

    const opts = getDefaultOptions();
    expect(opts.env!.NODE_EXTRA_CA_CERTS).toBe('/tmp/test-ca.crt');
  });

  it('sets SSL_CERT_FILE and CURL_CA_BUNDLE when bundle is available', () => {
    setProxyConfig({
      sessionId: 'test',
      port: 8000,
      caCertPath: '/tmp/ca.crt',
      caBundlePath: '/tmp/ca-bundle.pem',
    });

    const opts = getDefaultOptions();
    expect(opts.env!.SSL_CERT_FILE).toBe('/tmp/ca-bundle.pem');
    expect(opts.env!.CURL_CA_BUNDLE).toBe('/tmp/ca-bundle.pem');
    expect(opts.env!.REQUESTS_CA_BUNDLE).toBe('/tmp/ca-bundle.pem');
  });

  it('omits SSL_CERT_FILE/CURL_CA_BUNDLE when no bundle available', () => {
    setProxyConfig({
      sessionId: 'test',
      port: 8000,
      caCertPath: '/tmp/ca.crt',
      caBundlePath: null,
    });

    const opts = getDefaultOptions();
    // These should not be set by proxy config (may exist from process.env)
    expect(opts.env!.SSL_CERT_FILE).toBeUndefined();
    expect(opts.env!.CURL_CA_BUNDLE).toBeUndefined();
  });

  it('clears proxy env vars after clearProxyConfig', () => {
    setProxyConfig({
      sessionId: 'test',
      port: 8000,
      caCertPath: '/tmp/ca.crt',
      caBundlePath: null,
    });

    // Verify proxy is set
    let opts = getDefaultOptions();
    expect(opts.env!.HTTPS_PROXY).toBeTruthy();

    // Clear and verify
    clearProxyConfig();
    opts = getDefaultOptions();
    expect(opts.env!.HTTP_PROXY).toBeUndefined();
    expect(opts.env!.HTTPS_PROXY).toBeUndefined();
    expect(opts.env!.NODE_USE_ENV_PROXY).toBeUndefined();
    expect(opts.env!.NO_PROXY).toBeUndefined();
  });

  it('returns identical proxy env from reusable helper', () => {
    setProxyConfig({
      sessionId: 'helper-test',
      port: 8123,
      caCertPath: '/tmp/ca.crt',
      caBundlePath: '/tmp/ca-bundle.pem',
    });

    const opts = getDefaultOptions();
    const helperEnv = getCredentialProxyEnv();

    expect(opts.env!.HTTP_PROXY).toBe(helperEnv.HTTP_PROXY);
    expect(opts.env!.HTTPS_PROXY).toBe(helperEnv.HTTPS_PROXY);
    expect(opts.env!.NODE_USE_ENV_PROXY).toBe(helperEnv.NODE_USE_ENV_PROXY);
    expect(opts.env!.NO_PROXY).toBe(helperEnv.NO_PROXY);
    expect(opts.env!.NODE_EXTRA_CA_CERTS).toBe(helperEnv.NODE_EXTRA_CA_CERTS);
    expect(opts.env!.SSL_CERT_FILE).toBe(helperEnv.SSL_CERT_FILE);
    expect(opts.env!.CURL_CA_BUNDLE).toBe(helperEnv.CURL_CA_BUNDLE);
    expect(opts.env!.REQUESTS_CA_BUNDLE).toBe(helperEnv.REQUESTS_CA_BUNDLE);
  });
});
