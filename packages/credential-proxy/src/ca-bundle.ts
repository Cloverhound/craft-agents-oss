/**
 * CA Bundle Manager
 *
 * Creates a combined CA bundle containing system CAs + the proxy's ephemeral CA.
 * This is needed because SSL_CERT_FILE, CURL_CA_BUNDLE, and REQUESTS_CA_BUNDLE
 * REPLACE the default trust store (unlike NODE_EXTRA_CA_CERTS which appends).
 *
 * Without the system CAs included, non-intercepted HTTPS requests would fail
 * certificate validation.
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Common system CA bundle paths by platform */
const SYSTEM_CA_PATHS: Record<string, string[]> = {
  darwin: ['/etc/ssl/cert.pem'],
  linux: [
    '/etc/ssl/certs/ca-certificates.crt',    // Debian/Ubuntu
    '/etc/pki/tls/certs/ca-bundle.crt',       // RHEL/CentOS
    '/etc/ssl/ca-bundle.pem',                  // OpenSUSE
    '/etc/pki/tls/cacert.pem',                 // OpenELEC
  ],
  win32: [], // Windows uses its own cert store, not PEM files
};

/**
 * Find the system CA bundle file.
 * Returns null if not found (Windows or unusual Linux setup).
 */
export function findSystemCABundle(): string | null {
  const paths = SYSTEM_CA_PATHS[process.platform] ?? [];
  for (const p of paths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Create a combined CA bundle: system CAs + proxy CA cert.
 *
 * @param proxyCACertPem - The proxy's ephemeral CA certificate in PEM format
 * @param outputDir - Directory to write the combined bundle to
 * @returns Path to the combined bundle file, or null if system CAs not found
 */
export function createCABundle(proxyCACertPem: string, outputDir: string): string | null {
  const systemCAPath = findSystemCABundle();

  if (!systemCAPath) {
    // No system CA bundle found — can't create combined bundle.
    // NODE_EXTRA_CA_CERTS will still work for Node.js clients.
    return null;
  }

  const systemCAs = readFileSync(systemCAPath, 'utf-8');

  // Combine: system CAs first, then proxy CA
  const combined = `${systemCAs.trimEnd()}\n\n# Craft Agent Credential Proxy CA\n${proxyCACertPem}`;

  const bundlePath = join(outputDir, 'ca-bundle.pem');
  writeFileSync(bundlePath, combined, 'utf-8');

  return bundlePath;
}

/**
 * Clean up a CA bundle file.
 */
export function cleanupCABundle(bundlePath: string): void {
  try {
    if (existsSync(bundlePath)) {
      rmSync(bundlePath);
    }
  } catch {
    // Best effort
  }
}
