/**
 * Credential Proxy Server
 *
 * Transparent MITM HTTPS proxy that selectively intercepts requests to
 * credential-matching domains and injects authentication headers.
 *
 * Non-matching domains are tunneled through as standard CONNECT proxies
 * with zero overhead.
 *
 * Session identification via Proxy-Authorization header enables per-session
 * permission mode enforcement.
 */

import { createServer, type Server, type IncomingMessage } from 'node:http';
import { connect as tlsConnect, createServer as createTlsServer, type TLSSocket } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';
import { generateCA, forgeServerCert, cleanupCA, type CACert, type ForgedCert } from './ca';
import { createCABundle } from './ca-bundle';
import { SessionRegistry, type PermissionMode } from './session-registry';
import {
  hostnameMatchesCredentials,
  matchCredentialForUrl,
  interceptRequest,
  PermissionDeniedError,
} from './interceptor';
import type { LoadedCredentialConfig } from '@craft-agent/shared/credentials/credential-config-types';

export interface ProxyOptions {
  /** Loaded credential configs to match against */
  credentials: LoadedCredentialConfig[];
  /** Optional logger */
  log?: (message: string) => void;
}

export interface ProxyInstance {
  /** Port the proxy is listening on */
  port: number;
  /** Path to the CA certificate (for NODE_EXTRA_CA_CERTS) */
  caCertPath: string;
  /** Path to the combined CA bundle (for SSL_CERT_FILE, etc.), or null if no system CAs found */
  caBundlePath: string | null;
  /** Stop the proxy and clean up */
  stop(): void;
  /** Register a session with its permission mode */
  registerSession(sessionId: string, permissionMode: PermissionMode): void;
  /** Unregister a session */
  unregisterSession(sessionId: string): void;
  /** Update a session's permission mode */
  updateSessionMode(sessionId: string, permissionMode: PermissionMode): void;
  /** Reload credential configs (e.g., after credential add/remove) */
  reloadCredentials(credentials: LoadedCredentialConfig[]): void;
  /** Number of active sessions */
  sessionCount: number;
}

/**
 * Start the credential proxy server.
 *
 * The proxy listens on 127.0.0.1 with a random port. It handles CONNECT
 * requests, using Proxy-Authorization to identify sessions and selectively
 * MITM'ing domains that match credential URL patterns.
 */
export async function startProxy(options: ProxyOptions): Promise<ProxyInstance> {
  const log = options.log ?? (() => {});
  let credentials = options.credentials;

  // Generate ephemeral CA
  const ca = generateCA();
  log(`[credential-proxy] CA generated, cert at ${ca.certPath}`);

  // Create combined CA bundle
  const caBundlePath = createCABundle(ca.certPem, ca.tempDir);
  if (caBundlePath) {
    log(`[credential-proxy] CA bundle created at ${caBundlePath}`);
  } else {
    log('[credential-proxy] No system CA bundle found — SSL_CERT_FILE/CURL_CA_BUNDLE will not be set');
  }

  // Session registry
  const registry = new SessionRegistry();

  // Cert cache: hostname → ForgedCert
  const certCache = new Map<string, ForgedCert>();

  function getOrForgeServerCert(hostname: string): ForgedCert {
    let cert = certCache.get(hostname);
    if (!cert) {
      cert = forgeServerCert(hostname, ca);
      certCache.set(hostname, cert);
    }
    return cert;
  }

  /**
   * Extract session ID from Proxy-Authorization header.
   * Format: Basic base64("session-{id}:")
   */
  function extractSessionId(proxyAuth: string | undefined): string | null {
    if (!proxyAuth) return null;

    const parts = proxyAuth.split(' ');
    if (parts[0] !== 'Basic' || !parts[1]) return null;

    try {
      const decoded = Buffer.from(parts[1], 'base64').toString('utf-8');
      // Format: "session-{id}:x" (password is a dummy value for Bun compat)
      const [username] = decoded.split(':');
      if (username && username.startsWith('session-')) {
        return username.slice('session-'.length);
      }
    } catch {
      // Invalid base64
    }

    return null;
  }

  /**
   * Parse the CONNECT target into hostname and port.
   */
  function parseConnectTarget(url: string): { hostname: string; port: number } | null {
    const parts = url.split(':');
    if (parts.length !== 2) return null;
    const hostname = parts[0]!;
    const port = parseInt(parts[1]!, 10);
    if (isNaN(port)) return null;
    return { hostname, port };
  }

  /**
   * Handle a blind TCP tunnel (non-MITM passthrough).
   */
  function handleTunnel(clientSocket: Socket, hostname: string, port: number, head: Buffer): void {
    const serverSocket = netConnect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      // Forward any data the client sent before the 200 response (e.g., eager TLS ClientHello)
      if (head.length > 0) {
        serverSocket.write(head);
      }
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', (err) => {
      log(`[credential-proxy] Tunnel error to ${hostname}:${port}: ${err.message}`);
      clientSocket.destroy();
    });

    clientSocket.on('error', () => {
      serverSocket.destroy();
    });

    clientSocket.on('close', () => {
      serverSocket.destroy();
    });

    serverSocket.on('close', () => {
      clientSocket.destroy();
    });
  }

  /**
   * Handle a MITM'd connection: terminate client TLS, read request,
   * inject credentials, forward to upstream.
   *
   * We spin up a one-shot TLS server on a local port and pipe the
   * client socket to it. This is the reliable way to MITM in Node —
   * directly wrapping with `new TLSSocket(sock, { isServer: true })`
   * doesn't complete the handshake in Bun/Node.
   */
  function handleMitm(
    clientSocket: Socket,
    hostname: string,
    port: number,
    sessionId: string | null,
    head: Buffer,
  ): void {
    // Forge server cert for this hostname
    const serverCert = getOrForgeServerCert(hostname);

    // Create a one-shot TLS server to terminate the client's TLS
    const mitmServer = createTlsServer(
      { cert: serverCert.certPem, key: serverCert.keyPem },
      (tlsSocket: TLSSocket) => {
        // TLS handshake succeeded — we now have decrypted traffic
        log(`[credential-proxy] MITM TLS handshake complete for ${hostname}:${port}`);
        handleDecryptedConnection(tlsSocket, hostname, port, sessionId);

        // Close the one-shot server (no more connections needed)
        mitmServer.close();
      },
    );

    mitmServer.on('error', (err: Error) => {
      log(`[credential-proxy] MITM server error for ${hostname}: ${err.message}`);
      clientSocket.destroy();
    });

    mitmServer.on('tlsClientError', (err: Error) => {
      log(`[credential-proxy] TLS client error for ${hostname}: ${err.message}`);
      clientSocket.destroy();
      mitmServer.close();
    });

    // Listen on a random local port
    mitmServer.listen(0, '127.0.0.1', () => {
      const addr = mitmServer.address();
      const mitmPort = typeof addr === 'object' && addr ? addr.port : 0;

      // Respond 200 to client to indicate CONNECT tunnel established
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      // Pipe client socket to the local MITM TLS server
      const bridgeSocket = netConnect(mitmPort, '127.0.0.1', () => {
        // Forward any data the client sent before the 200 response (e.g., eager TLS ClientHello)
        if (head.length > 0) {
          bridgeSocket.write(head);
        }
        clientSocket.pipe(bridgeSocket);
        bridgeSocket.pipe(clientSocket);
      });

      bridgeSocket.on('error', () => {
        clientSocket.destroy();
        mitmServer.close();
      });

      clientSocket.on('error', () => {
        bridgeSocket.destroy();
        mitmServer.close();
      });

      clientSocket.on('close', () => {
        bridgeSocket.destroy();
        mitmServer.close();
      });
    });
  }

  /**
   * Handle a decrypted TLS connection from the MITM server.
   * Reads the HTTP request, injects credentials, forwards to upstream.
   */
  function handleDecryptedConnection(
    tlsSocket: TLSSocket,
    hostname: string,
    port: number,
    sessionId: string | null,
  ): void {
    tlsSocket.on('error', (err: Error) => {
      log(`[credential-proxy] Decrypted connection error for ${hostname}: ${err.message}`);
      tlsSocket.destroy();
    });

    // Buffer incoming data to read the HTTP request
    let requestBuffer = Buffer.alloc(0);
    let requestParsed = false;

    tlsSocket.on('data', (chunk: Buffer) => {
      if (requestParsed) return; // Already handling this connection

      requestBuffer = Buffer.concat([requestBuffer, chunk]);

      // Check if we have the full headers (look for \r\n\r\n)
      const headerEndIndex = requestBuffer.indexOf('\r\n\r\n');
      if (headerEndIndex === -1) {
        // Need more data
        if (requestBuffer.length > 64 * 1024) {
          // Headers too large
          tlsSocket.write('HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n');
          tlsSocket.destroy();
        }
        return;
      }

      requestParsed = true;

      // Parse the HTTP request headers
      const headerStr = requestBuffer.slice(0, headerEndIndex).toString('utf-8');
      const bodyStart = requestBuffer.slice(headerEndIndex + 4);
      const lines = headerStr.split('\r\n');
      const requestLine = lines[0]!;
      const [method, path, httpVersion] = requestLine.split(' ');

      if (!method || !path) {
        tlsSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        tlsSocket.destroy();
        return;
      }

      // Parse headers
      const requestHeaders: Record<string, string> = {};
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]!;
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
          const name = line.slice(0, colonIdx).trim();
          const value = line.slice(colonIdx + 1).trim();
          requestHeaders[name.toLowerCase()] = value;
        }
      }

      // Build full URL for credential matching
      const fullUrl = `https://${hostname}${port !== 443 ? `:${port}` : ''}${path}`;

      // Get session permission mode
      const permissionMode = sessionId ? registry.getMode(sessionId) : 'safe';

      log(`[credential-proxy] MITM request: ${method} ${fullUrl} (session=${sessionId}, mode=${permissionMode}, creds=${credentials.length})`);

      // Intercept and inject credentials
      interceptRequest(fullUrl, method, credentials, permissionMode)
        .then((result) => {
          if (!result) {
            const mc = matchCredentialForUrl(fullUrl, credentials);
            if (mc) {
              log(`[credential-proxy] No secret found for ${mc.slug} (${method} ${hostname}${path})`);
            }
          }
          // Determine the URL to use (may be modified for query auth)
          const targetPath = result ? new URL(result.url).pathname + new URL(result.url).search : path;

          // Build headers for upstream request
          const upstreamHeaders: Record<string, string> = { ...requestHeaders };

          // Inject credential headers
          if (result) {
            for (const [name, value] of Object.entries(result.headers)) {
              upstreamHeaders[name.toLowerCase()] = value;
            }
            log(`[credential-proxy] Injected ${result.credential.slug} credentials for ${method} ${hostname}${path}`);
          }

          // Remove hop-by-hop headers that shouldn't be forwarded
          delete upstreamHeaders['proxy-authorization'];
          delete upstreamHeaders['proxy-connection'];

          // Determine content length for body forwarding
          const contentLength = parseInt(upstreamHeaders['content-length'] ?? '0', 10);

          // Connect to upstream server
          const upstreamSocket = tlsConnect({
            host: hostname,
            port,
            servername: hostname,
          }, () => {
            // Build request line and headers
            const reqLines: string[] = [
              `${method} ${targetPath} ${httpVersion || 'HTTP/1.1'}`,
            ];

            for (const [name, value] of Object.entries(upstreamHeaders)) {
              reqLines.push(`${name}: ${value}`);
            }

            reqLines.push('', ''); // End of headers
            const reqStr = reqLines.join('\r\n');

            upstreamSocket.write(reqStr);

            // Send any body data we already have
            if (bodyStart.length > 0) {
              upstreamSocket.write(bodyStart);
            }

            // If there's more body data to come, pipe the rest
            const bodyRemaining = contentLength - bodyStart.length;
            if (bodyRemaining > 0) {
              let bytesReceived = 0;
              const onData = (chunk: Buffer) => {
                upstreamSocket.write(chunk);
                bytesReceived += chunk.length;
                if (bytesReceived >= bodyRemaining) {
                  tlsSocket.removeListener('data', onData);
                }
              };
              tlsSocket.on('data', onData);
            }

            // Pipe upstream response back to client
            upstreamSocket.pipe(tlsSocket);
          });

          upstreamSocket.on('error', (err: Error) => {
            log(`[credential-proxy] Upstream error to ${hostname}: ${err.message}`);
            tlsSocket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\nUpstream connection failed: ${err.message}`);
            tlsSocket.destroy();
          });

          tlsSocket.on('close', () => {
            upstreamSocket.destroy();
          });
        })
        .catch((err) => {
          if (err instanceof PermissionDeniedError) {
            const body = JSON.stringify({ error: 'permission_denied', message: err.message });
            tlsSocket.write(
              `HTTP/1.1 403 Forbidden\r\n` +
              `Content-Type: application/json\r\n` +
              `Content-Length: ${Buffer.byteLength(body)}\r\n` +
              `\r\n${body}`
            );
          } else {
            log(`[credential-proxy] Interception error: ${err}`);
            tlsSocket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
          }
          tlsSocket.destroy();
        });
    });
  }

  // Create the proxy HTTP server
  const server = createServer();

  // Handle CONNECT requests (HTTPS proxy)
  server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const target = parseConnectTarget(req.url || '');
    if (!target) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const { hostname, port } = target;

    // Extract session ID from Proxy-Authorization header
    const sessionId = extractSessionId(req.headers['proxy-authorization'] as string | undefined);

    // Check if this hostname matches any credential patterns
    const shouldMitm = hostnameMatchesCredentials(hostname, port, credentials);
    log(`[credential-proxy] CONNECT ${hostname}:${port} (session=${sessionId}, mitm=${shouldMitm}, head=${head.length}b)`);

    if (shouldMitm) {
      // MITM: intercept this connection
      handleMitm(clientSocket, hostname, port, sessionId, head);
    } else {
      // Tunnel: pass through without interception
      handleTunnel(clientSocket, hostname, port, head);
    }
  });

  // Handle regular HTTP requests (non-CONNECT) — just forward them
  server.on('request', (req: IncomingMessage, res) => {
    // The proxy should only handle CONNECT for HTTPS
    // Regular HTTP requests through the proxy are unusual but handle gracefully
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('This proxy only handles HTTPS CONNECT requests');
  });

  server.on('error', (err) => {
    log(`[credential-proxy] Server error: ${err.message}`);
  });

  // Listen on localhost with random port
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  log(`[credential-proxy] Listening on 127.0.0.1:${port}`);

  return {
    port,
    caCertPath: ca.certPath,
    caBundlePath,

    stop() {
      log('[credential-proxy] Stopping proxy');
      server.close();
      certCache.clear();
      registry.clear();
      cleanupCA(ca);
    },

    registerSession(sessionId: string, permissionMode: PermissionMode) {
      registry.register(sessionId, permissionMode);
      log(`[credential-proxy] Registered session ${sessionId} (mode: ${permissionMode})`);
    },

    unregisterSession(sessionId: string) {
      registry.unregister(sessionId);
      log(`[credential-proxy] Unregistered session ${sessionId}`);
    },

    updateSessionMode(sessionId: string, permissionMode: PermissionMode) {
      registry.updateMode(sessionId, permissionMode);
      log(`[credential-proxy] Updated session ${sessionId} mode to ${permissionMode}`);
    },

    reloadCredentials(newCredentials: LoadedCredentialConfig[]) {
      credentials = newCredentials;
      log(`[credential-proxy] Reloaded credentials (${newCredentials.length} total)`);
    },

    get sessionCount() {
      return registry.size;
    },
  };
}
