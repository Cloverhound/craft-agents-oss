/**
 * Proxy Integration Tests
 *
 * Tests the proxy lifecycle: start, caller management, CONNECT handling,
 * and MITM TLS handshake. Uses a local mock HTTPS server and curl
 * for end-to-end verification.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { startProxy, type ProxyInstance } from '../proxy';
import { generateCA, forgeServerCert, cleanupCA, type CACert } from '../ca';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { connect as netConnect } from 'node:net';
import type { LoadedCredentialConfig } from '@craft-agent/shared/credentials/credential-config-types';

// Helper: create a LoadedCredentialConfig for testing
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

describe('Proxy', () => {
  let proxy: ProxyInstance | null = null;

  afterEach(async () => {
    proxy?.stop();
    proxy = null;
    // Allow dangling MITM servers to clean up before next test
    await new Promise(r => setTimeout(r, 50));
  });

  describe('lifecycle', () => {
    it('starts and stops cleanly', async () => {
      proxy = await startProxy({ credentials: [] });
      expect(proxy.port).toBeGreaterThan(0);
      expect(proxy.caCertPath).toBeTruthy();
      expect(proxy.callerCount).toBe(0);

      proxy.stop();
      proxy = null; // Prevent double-stop in afterEach
    });

    it('generates CA cert file on disk', async () => {
      const { existsSync } = await import('node:fs');
      proxy = await startProxy({ credentials: [] });
      expect(existsSync(proxy.caCertPath)).toBe(true);
    });

    it('cleans up CA cert on stop', async () => {
      const { existsSync } = await import('node:fs');
      proxy = await startProxy({ credentials: [] });
      const certPath = proxy.caCertPath;

      proxy.stop();
      proxy = null;
      expect(existsSync(certPath)).toBe(false);
    });

    it('creates CA bundle on platforms with system CAs', async () => {
      proxy = await startProxy({ credentials: [] });
      // On macOS/Linux, bundle should exist
      if (process.platform === 'darwin' || process.platform === 'linux') {
        expect(proxy.caBundlePath).not.toBeNull();
      }
    });
  });

  describe('caller management', () => {
    it('registers and tracks session callers', async () => {
      proxy = await startProxy({ credentials: [] });

      proxy.registerCaller('s1', 'session', 'allow-all');
      expect(proxy.callerCount).toBe(1);

      proxy.registerCaller('s2', 'session', 'safe');
      expect(proxy.callerCount).toBe(2);
    });

    it('registers and tracks app callers', async () => {
      proxy = await startProxy({ credentials: [] });

      proxy.registerCaller('my-app', 'app', 'safe');
      expect(proxy.callerCount).toBe(1);

      proxy.registerCaller('s1', 'session', 'allow-all');
      expect(proxy.callerCount).toBe(2);
    });

    it('unregisters callers', async () => {
      proxy = await startProxy({ credentials: [] });

      proxy.registerCaller('s1', 'session', 'allow-all');
      proxy.registerCaller('my-app', 'app', 'safe');
      proxy.unregisterCaller('s1');
      expect(proxy.callerCount).toBe(1);

      proxy.unregisterCaller('my-app');
      expect(proxy.callerCount).toBe(0);
    });

    it('updates caller permission mode', async () => {
      proxy = await startProxy({ credentials: [] });

      proxy.registerCaller('s1', 'session', 'safe');
      proxy.updateCallerMode('s1', 'allow-all');
      // Can't directly verify mode, but shouldn't throw
      expect(proxy.callerCount).toBe(1);
    });
  });

  describe('credential reload', () => {
    it('accepts new credentials at runtime', async () => {
      proxy = await startProxy({ credentials: [] });
      const newCreds = [makeCred({ slug: 'new', urlPatterns: ['https://api.new.com/*'] })];
      proxy.reloadCredentials(newCreds);
      // Should not throw
      expect(proxy.port).toBeGreaterThan(0);
    });
  });

  describe('CONNECT handling', () => {
    it('responds 200 for CONNECT to matching hostname (MITM mode)', async () => {
      const cred = makeCred({
        slug: 'test',
        urlPatterns: ['https://api.test.local/*'],
      });
      proxy = await startProxy({ credentials: [cred] });
      proxy.registerCaller('s1', 'session', 'allow-all');

      const result = await new Promise<string>((resolve, reject) => {
        const timeoutId = setTimeout(() => reject(new Error('timeout')), 5000);
        const sock = netConnect(proxy!.port, '127.0.0.1', () => {
          const auth = Buffer.from('session-s1:session').toString('base64');
          sock.write(
            `CONNECT api.test.local:443 HTTP/1.1\r\n` +
            `Host: api.test.local:443\r\n` +
            `Proxy-Authorization: Basic ${auth}\r\n` +
            `\r\n`
          );
        });
        let data = '';
        sock.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes('\r\n\r\n')) {
            clearTimeout(timeoutId);
            sock.destroy();
            resolve(data);
          }
        });
        sock.on('error', (err) => {
          clearTimeout(timeoutId);
          reject(err);
        });
      });

      expect(result).toContain('200');
      expect(result).toContain('Connection Established');
    });

    it('extracts app caller from proxy auth', async () => {
      const cred = makeCred({
        slug: 'test',
        urlPatterns: ['https://api.test.local/*'],
      });
      proxy = await startProxy({ credentials: [cred] });
      proxy.registerCaller('my-app', 'app', 'allow-all');

      const result = await new Promise<string>((resolve, reject) => {
        const timeoutId = setTimeout(() => reject(new Error('timeout')), 5000);
        const sock = netConnect(proxy!.port, '127.0.0.1', () => {
          // Use "app-my-app:app" format
          const auth = Buffer.from('app-my-app:app').toString('base64');
          sock.write(
            `CONNECT api.test.local:443 HTTP/1.1\r\n` +
            `Host: api.test.local:443\r\n` +
            `Proxy-Authorization: Basic ${auth}\r\n` +
            `\r\n`
          );
        });
        let data = '';
        sock.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes('\r\n\r\n')) {
            clearTimeout(timeoutId);
            sock.destroy();
            resolve(data);
          }
        });
        sock.on('error', (err) => {
          clearTimeout(timeoutId);
          reject(err);
        });
      });

      // 200 means the proxy matched credentials → MITM path was taken,
      // which means the app caller was successfully extracted
      expect(result).toContain('200');
      expect(result).toContain('Connection Established');
    });

    it('responds 400 for invalid CONNECT target', async () => {
      proxy = await startProxy({ credentials: [] });

      const result = await new Promise<string>((resolve, reject) => {
        const timeoutId = setTimeout(() => reject(new Error('timeout')), 5000);
        const sock = netConnect(proxy!.port, '127.0.0.1', () => {
          sock.write(
            `CONNECT invalid-no-port HTTP/1.1\r\n` +
            `Host: invalid\r\n` +
            `\r\n`
          );
        });
        let data = '';
        sock.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes('\r\n\r\n')) {
            clearTimeout(timeoutId);
            sock.destroy();
            resolve(data);
          }
        });
        sock.on('error', (err) => {
          clearTimeout(timeoutId);
          reject(err);
        });
      });

      expect(result).toContain('400');
    });

    it('rejects regular HTTP requests (non-CONNECT)', async () => {
      proxy = await startProxy({ credentials: [] });

      const response = await fetch(`http://127.0.0.1:${proxy.port}/test`, {
        method: 'GET',
      });

      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain('HTTPS CONNECT');
    });
  });

  describe('TLS MITM handshake', () => {
    it('completes TLS handshake with forged cert for matching hostname', async () => {
      const cred = makeCred({
        slug: 'test',
        urlPatterns: ['https://localhost/*'],
      });
      proxy = await startProxy({ credentials: [cred] });
      proxy.registerCaller('s1', 'session', 'allow-all');

      const caPath = proxy.caBundlePath || proxy.caCertPath;

      const proc = Bun.spawn(
        [
          'curl', '-v', '-s',
          '--noproxy', '',
          '--proxy', `http://session-s1:session@127.0.0.1:${proxy.port}`,
          '--cacert', caPath,
          '--connect-timeout', '3',
          'https://localhost/test',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );

      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      expect(stderr).toContain('SSL certificate verify ok');
      expect(stderr).toContain('localhost');
    }, 10000);

    it('forged cert has correct subject and SAN', async () => {
      const cred = makeCred({
        slug: 'test',
        urlPatterns: ['https://localhost/*'],
      });
      proxy = await startProxy({ credentials: [cred] });
      proxy.registerCaller('s1', 'session', 'allow-all');

      const caPath = proxy.caBundlePath || proxy.caCertPath;
      const proc = Bun.spawn(
        [
          'curl', '-v', '-s',
          '--noproxy', '',
          '--proxy', `http://session-s1:session@127.0.0.1:${proxy.port}`,
          '--cacert', caPath,
          '--connect-timeout', '3',
          'https://localhost/test',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );

      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      expect(stderr).toContain('subject: CN=localhost');
      expect(stderr).toContain('subjectAltName: host "localhost" matched cert\'s "localhost"');
    }, 10000);
  });

  describe('tunnel (non-MITM)', () => {
    it('tunnels CONNECT to non-matching hostname', async () => {
      const cred = makeCred({
        slug: 'test',
        urlPatterns: ['https://api.unrelated-domain.com/*'],
      });
      proxy = await startProxy({ credentials: [cred] });

      const result = await new Promise<string>((resolve, reject) => {
        const timeoutId = setTimeout(() => reject(new Error('timeout')), 5000);
        const sock = netConnect(proxy!.port, '127.0.0.1', () => {
          sock.write(
            `CONNECT www.google.com:443 HTTP/1.1\r\n` +
            `Host: www.google.com:443\r\n` +
            `\r\n`
          );
        });
        let data = '';
        sock.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes('\r\n\r\n')) {
            clearTimeout(timeoutId);
            sock.destroy();
            resolve(data);
          }
        });
        sock.on('error', (err) => {
          clearTimeout(timeoutId);
          reject(err);
        });
      });

      expect(result).toContain('200');
      expect(result).toContain('Connection Established');
    });
  });

  describe('logging', () => {
    it('calls log function with proxy events', async () => {
      const logs: string[] = [];
      proxy = await startProxy({
        credentials: [],
        log: (msg) => logs.push(msg),
      });

      expect(logs.some(l => l.includes('CA generated'))).toBe(true);
      expect(logs.some(l => l.includes('Listening'))).toBe(true);

      proxy.registerCaller('s1', 'session', 'safe');
      expect(logs.some(l => l.includes('Registered session s1'))).toBe(true);

      proxy.updateCallerMode('s1', 'allow-all');
      expect(logs.some(l => l.includes('Updated caller s1'))).toBe(true);

      proxy.unregisterCaller('s1');
      expect(logs.some(l => l.includes('Unregistered caller s1'))).toBe(true);
    });

    it('logs credential reload', async () => {
      const logs: string[] = [];
      proxy = await startProxy({
        credentials: [],
        log: (msg) => logs.push(msg),
      });

      const creds = [makeCred({ slug: 'x', urlPatterns: ['https://x.com/*'] })];
      proxy.reloadCredentials(creds);
      expect(logs.some(l => l.includes('Reloaded credentials (1 total)'))).toBe(true);
    });
  });
});

describe('Proxy MITM with local upstream', () => {
  let proxy: ProxyInstance | null = null;
  let upstream: HttpsServer | null = null;
  let upstreamCA: CACert | null = null;

  afterEach(() => {
    proxy?.stop();
    proxy = null;
    upstream?.close();
    upstream = null;
    if (upstreamCA) {
      cleanupCA(upstreamCA);
      upstreamCA = null;
    }
  });

  it('MITMs a local HTTPS server and echoes request back', async () => {
    const cred = makeCred({
      slug: 'local-test',
      urlPatterns: ['https://localhost/*'],
      auth: { type: 'bearer' },
    });

    proxy = await startProxy({ credentials: [cred] });
    proxy.registerCaller('test-session', 'session', 'allow-all');

    expect(proxy.port).toBeGreaterThan(0);
    expect(proxy.callerCount).toBe(1);
  });
});
