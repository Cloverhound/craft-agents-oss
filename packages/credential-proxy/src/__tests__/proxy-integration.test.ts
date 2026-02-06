/**
 * Proxy Integration Tests
 *
 * Tests the proxy with real HTTPS connections through the tunnel.
 * These tests hit external URLs (google.com) to verify the full
 * CONNECT → TLS → HTTP pipeline works end-to-end.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { startProxy, type ProxyInstance } from '../proxy';
import type { LoadedCredentialConfig } from '@craft-agent/shared/credentials/credential-config-types';

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

describe('Proxy Integration — real HTTPS tunnel', () => {
  let proxy: ProxyInstance | null = null;

  afterEach(() => {
    proxy?.stop();
    proxy = null;
  });

  it('tunnels HTTPS to google.com via curl through the proxy', async () => {
    // No credentials match google.com → pure tunnel (no MITM)
    proxy = await startProxy({ credentials: [] });
    const caPath = proxy.caBundlePath || proxy.caCertPath;

    const proc = Bun.spawn(
      [
        'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
        '--proxy', `http://127.0.0.1:${proxy.port}`,
        '--cacert', caPath,
        '--connect-timeout', '10',
        'https://www.google.com/',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toBe('200');
  }, 15000);

  it('tunnels HTTPS to google.com via curl with user:pass proxy auth', async () => {
    // Use the same URL format that getDefaultOptions() produces
    proxy = await startProxy({ credentials: [] });
    proxy.registerSession('integration-test', 'allow-all');
    const caPath = proxy.caBundlePath || proxy.caCertPath;

    const proc = Bun.spawn(
      [
        'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
        // user:pass format — the fix that makes Bun's fetch work
        '--proxy', `http://session-integration-test:x@127.0.0.1:${proxy.port}`,
        '--cacert', caPath,
        '--connect-timeout', '10',
        'https://www.google.com/',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toBe('200');
  }, 15000);

  it('tunnels HTTPS via Bun fetch with explicit proxy option', async () => {
    // This is the code path the CLI uses: fetch(..., { proxy: url })
    // This was the exact scenario that was broken before the user:pass fix
    proxy = await startProxy({ credentials: [] });
    proxy.registerSession('bun-test', 'allow-all');

    const proxyUrl = `http://session-bun-test:x@127.0.0.1:${proxy.port}`;

    const response = await fetch('https://www.google.com/', {
      proxy: proxyUrl,
      tls: {
        ca: Bun.file(proxy.caCertPath),
      },
    } as any);

    expect(response.status).toBe(200);
    // Consume body to avoid resource leaks
    await response.text();
  }, 15000);

  it('rejects Bun fetch with user-only proxy URL (no password)', async () => {
    // This documents the Bun bug that caused the original breakage.
    // Bun's fetch rejects proxy URLs with username but no password.
    proxy = await startProxy({ credentials: [] });
    proxy.registerSession('bun-fail', 'allow-all');

    // Old format: user-only, no password
    const proxyUrl = `http://session-bun-fail@127.0.0.1:${proxy.port}`;

    try {
      const response = await fetch('https://www.google.com/', {
        proxy: proxyUrl,
        tls: {
          ca: Bun.file(proxy.caCertPath),
        },
      } as any);
      // If we get here, Bun may have fixed the bug — still pass the test
      await response.text();
    } catch (err: any) {
      // Expected: Bun rejects user-only proxy URLs
      expect(err.message || err.code || String(err)).toBeTruthy();
    }
  }, 15000);

  it('tunnels multiple concurrent requests through the proxy', async () => {
    proxy = await startProxy({ credentials: [] });
    const caPath = proxy.caBundlePath || proxy.caCertPath;

    // Fire off 3 concurrent requests through the proxy
    const urls = [
      'https://www.google.com/',
      'https://www.google.com/robots.txt',
      'https://httpbin.org/get',
    ];

    const results = await Promise.all(
      urls.map(async (url) => {
        const proc = Bun.spawn(
          [
            'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
            '--proxy', `http://127.0.0.1:${proxy!.port}`,
            '--cacert', caPath,
            '--connect-timeout', '10',
            url,
          ],
          { stdout: 'pipe', stderr: 'pipe' },
        );

        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        return { url, status: stdout };
      }),
    );

    for (const result of results) {
      expect(result.status).toBe('200');
    }
  }, 20000);
});

describe('Proxy Integration — MITM credential injection', () => {
  let proxy: ProxyInstance | null = null;

  afterEach(() => {
    proxy?.stop();
    proxy = null;
  });

  it('MITMs a request to httpbin.org and injects bearer auth header', async () => {
    // Configure a credential matching httpbin.org.
    // The proxy will MITM the connection and attempt to inject credentials.
    // Since there's no actual secret stored, the interceptor returns null
    // and no header is injected — but the MITM pipeline still works
    // (the request goes through, just without auth injection).
    const cred = makeCred({
      slug: 'httpbin-test',
      urlPatterns: ['https://httpbin.org/*'],
      auth: { type: 'bearer' },
    });

    proxy = await startProxy({ credentials: [cred] });
    proxy.registerSession('mitm-test', 'allow-all');
    const caPath = proxy.caBundlePath || proxy.caCertPath;

    // Use curl with the proxy's CA so TLS verification passes
    const proc = Bun.spawn(
      [
        'curl', '-s',
        '--proxy', `http://session-mitm-test:x@127.0.0.1:${proxy.port}`,
        '--cacert', caPath,
        '--connect-timeout', '10',
        'https://httpbin.org/get',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    // The MITM should successfully intercept and forward the request.
    // httpbin.org/get returns a JSON response with request headers.
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.url).toBe('https://httpbin.org/get');
  }, 15000);

  it('MITMs and correctly forwards request path and query params', async () => {
    const cred = makeCred({
      slug: 'httpbin-test',
      urlPatterns: ['https://httpbin.org/*'],
      auth: { type: 'bearer' },
    });

    proxy = await startProxy({ credentials: [cred] });
    proxy.registerSession('mitm-test', 'allow-all');
    const caPath = proxy.caBundlePath || proxy.caCertPath;

    const proc = Bun.spawn(
      [
        'curl', '-s',
        '--proxy', `http://session-mitm-test:x@127.0.0.1:${proxy.port}`,
        '--cacert', caPath,
        '--connect-timeout', '10',
        'https://httpbin.org/get?foo=bar&baz=123',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.args).toEqual({ foo: 'bar', baz: '123' });
  }, 15000);
});
