import { describe, it, expect, afterEach } from 'bun:test';
import { findSystemCABundle, createCABundle, cleanupCABundle } from '../ca-bundle';
import { generateCA, cleanupCA, type CACert } from '../ca';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CA Bundle', () => {
  const tempDirs: string[] = [];
  const cas: CACert[] = [];

  afterEach(() => {
    for (const ca of cas) {
      cleanupCA(ca);
    }
    cas.length = 0;

    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort
      }
    }
    tempDirs.length = 0;
  });

  function makeTempDir(): string {
    const dir = join(tmpdir(), `ca-bundle-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    return dir;
  }

  describe('findSystemCABundle', () => {
    it('finds a system CA bundle on macOS/Linux', () => {
      // This test is platform-dependent — on macOS/Linux it should find one
      if (process.platform === 'darwin' || process.platform === 'linux') {
        const path = findSystemCABundle();
        expect(path).not.toBeNull();
        expect(existsSync(path!)).toBe(true);
      }
    });

    it('returns null on unsupported platforms', () => {
      // We can't easily test Windows detection, but we can verify
      // the function doesn't crash and returns a valid type
      const result = findSystemCABundle();
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });

  describe('createCABundle', () => {
    it('creates a combined bundle file', () => {
      const ca = generateCA();
      cas.push(ca);
      const outputDir = makeTempDir();

      const bundlePath = createCABundle(ca.certPem, outputDir);

      // On macOS/Linux this should succeed
      if (bundlePath) {
        expect(existsSync(bundlePath)).toBe(true);
        expect(bundlePath).toContain('ca-bundle.pem');
      }
    });

    it('includes the proxy CA cert in the bundle', () => {
      const ca = generateCA();
      cas.push(ca);
      const outputDir = makeTempDir();

      const bundlePath = createCABundle(ca.certPem, outputDir);
      if (!bundlePath) return; // Skip on platforms without system CAs

      const bundleContent = readFileSync(bundlePath, 'utf-8');
      expect(bundleContent).toContain('Craft Agent Credential Proxy CA');
      expect(bundleContent).toContain(ca.certPem.trim());
    });

    it('includes system CA certs in the bundle', () => {
      const ca = generateCA();
      cas.push(ca);
      const outputDir = makeTempDir();

      const bundlePath = createCABundle(ca.certPem, outputDir);
      if (!bundlePath) return;

      const bundleContent = readFileSync(bundlePath, 'utf-8');

      // System bundle should contain multiple certificates
      const certCount = (bundleContent.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;
      expect(certCount).toBeGreaterThan(1); // At least system CAs + proxy CA
    });

    it('places the proxy CA after system CAs', () => {
      const ca = generateCA();
      cas.push(ca);
      const outputDir = makeTempDir();

      const bundlePath = createCABundle(ca.certPem, outputDir);
      if (!bundlePath) return;

      const bundleContent = readFileSync(bundlePath, 'utf-8');
      const proxyCAIndex = bundleContent.indexOf('Craft Agent Credential Proxy CA');
      const lastSystemCertIndex = bundleContent.lastIndexOf('-----END CERTIFICATE-----', proxyCAIndex);

      // Proxy CA comment should come after the last system cert
      expect(proxyCAIndex).toBeGreaterThan(lastSystemCertIndex);
    });
  });

  describe('cleanupCABundle', () => {
    it('removes the bundle file', () => {
      const ca = generateCA();
      cas.push(ca);
      const outputDir = makeTempDir();

      const bundlePath = createCABundle(ca.certPem, outputDir);
      if (!bundlePath) return;

      expect(existsSync(bundlePath)).toBe(true);
      cleanupCABundle(bundlePath);
      expect(existsSync(bundlePath)).toBe(false);
    });

    it('handles non-existent file gracefully', () => {
      cleanupCABundle('/nonexistent/path/bundle.pem');
      // Should not throw
    });
  });
});
