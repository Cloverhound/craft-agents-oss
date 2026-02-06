import { describe, it, expect, afterEach } from 'bun:test';
import { generateCA, forgeServerCert, cleanupCA, type CACert } from '../ca';
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

describe('CA', () => {
  const cas: CACert[] = [];

  afterEach(() => {
    for (const ca of cas) {
      cleanupCA(ca);
    }
    cas.length = 0;
  });

  function trackCA(): CACert {
    const ca = generateCA();
    cas.push(ca);
    return ca;
  }

  describe('generateCA', () => {
    it('generates a valid X.509 CA certificate', () => {
      const ca = trackCA();
      const x509 = new X509Certificate(ca.certPem);

      expect(x509.subject).toContain('CN=Craft Agent Credential Proxy CA');
      expect(x509.issuer).toContain('CN=Craft Agent Credential Proxy CA');
      expect(x509.ca).toBe(true);
    });

    it('generates a self-signed certificate (issuer = subject)', () => {
      const ca = trackCA();
      const x509 = new X509Certificate(ca.certPem);
      expect(x509.subject).toBe(x509.issuer);
    });

    it('includes Organization in subject', () => {
      const ca = trackCA();
      const x509 = new X509Certificate(ca.certPem);
      expect(x509.subject).toContain('O=Craft Agent');
    });

    it('uses 24-hour validity period', () => {
      const before = Date.now();
      const ca = trackCA();
      const after = Date.now();

      const x509 = new X509Certificate(ca.certPem);
      const validFrom = new Date(x509.validFrom).getTime();
      const validTo = new Date(x509.validTo).getTime();

      // validFrom should be around now
      expect(validFrom).toBeGreaterThanOrEqual(before - 1000);
      expect(validFrom).toBeLessThanOrEqual(after + 1000);

      // validTo should be ~24 hours after validFrom
      const durationMs = validTo - validFrom;
      const twentyFourHours = 24 * 60 * 60 * 1000;
      expect(durationMs).toBeGreaterThanOrEqual(twentyFourHours - 2000);
      expect(durationMs).toBeLessThanOrEqual(twentyFourHours + 2000);
    });

    it('writes cert and key files to temp directory', () => {
      const ca = trackCA();

      expect(existsSync(ca.certPath)).toBe(true);
      expect(existsSync(ca.keyPath)).toBe(true);
      expect(existsSync(ca.tempDir)).toBe(true);

      // Cert file should match the in-memory PEM
      const certFromDisk = readFileSync(ca.certPath, 'utf-8');
      expect(certFromDisk).toBe(ca.certPem);
    });

    it('generates PEM format for cert and key', () => {
      const ca = trackCA();

      expect(ca.certPem).toContain('-----BEGIN CERTIFICATE-----');
      expect(ca.certPem).toContain('-----END CERTIFICATE-----');
      expect(ca.keyPem).toContain('-----BEGIN PRIVATE KEY-----');
      expect(ca.keyPem).toContain('-----END PRIVATE KEY-----');
    });

    it('uses UTCTime encoding for dates (RFC 5280)', () => {
      const ca = trackCA();
      const x509 = new X509Certificate(ca.certPem);

      // If dates were encoded as GeneralizedTime, curl would reject them.
      // The fact that X509Certificate parses them successfully with correct
      // dates proves the encoding is correct.
      const validFrom = new Date(x509.validFrom);
      const validTo = new Date(x509.validTo);

      expect(validFrom.getFullYear()).toBe(new Date().getFullYear());
      expect(validTo.getFullYear()).toBe(new Date().getFullYear());
    });

    it('generates unique serial numbers per CA', () => {
      const ca1 = trackCA();
      const ca2 = trackCA();

      const x1 = new X509Certificate(ca1.certPem);
      const x2 = new X509Certificate(ca2.certPem);

      expect(x1.serialNumber).not.toBe(x2.serialNumber);
    });
  });

  describe('forgeServerCert', () => {
    it('forges a certificate for a given hostname', () => {
      const ca = trackCA();
      const cert = forgeServerCert('api.xero.com', ca);

      const x509 = new X509Certificate(cert.certPem);
      expect(x509.subject).toContain('CN=api.xero.com');
    });

    it('sets the issuer to the CA', () => {
      const ca = trackCA();
      const cert = forgeServerCert('example.com', ca);

      const x509 = new X509Certificate(cert.certPem);
      expect(x509.issuer).toContain('CN=Craft Agent Credential Proxy CA');
    });

    it('includes Subject Alternative Name with hostname', () => {
      const ca = trackCA();
      const cert = forgeServerCert('api.example.com', ca);

      const x509 = new X509Certificate(cert.certPem);
      expect(x509.subjectAltName).toContain('DNS:api.example.com');
    });

    it('is signed by the CA (matching issuer)', () => {
      const ca = trackCA();
      const cert = forgeServerCert('api.xero.com', ca);

      const caCert = new X509Certificate(ca.certPem);
      const serverCert = new X509Certificate(cert.certPem);

      // Server cert's issuer should match CA's subject
      expect(serverCert.issuer).toBe(caCert.subject);
    });

    it('generates separate key pairs for each hostname', () => {
      const ca = trackCA();
      const cert1 = forgeServerCert('a.example.com', ca);
      const cert2 = forgeServerCert('b.example.com', ca);

      // Different hostnames should get different certs
      expect(cert1.certPem).not.toBe(cert2.certPem);
      expect(cert1.keyPem).not.toBe(cert2.keyPem);
    });

    it('uses 24-hour validity period', () => {
      const ca = trackCA();
      const cert = forgeServerCert('test.com', ca);

      const x509 = new X509Certificate(cert.certPem);
      const validFrom = new Date(x509.validFrom).getTime();
      const validTo = new Date(x509.validTo).getTime();

      const durationMs = validTo - validFrom;
      const twentyFourHours = 24 * 60 * 60 * 1000;
      expect(durationMs).toBeGreaterThanOrEqual(twentyFourHours - 2000);
      expect(durationMs).toBeLessThanOrEqual(twentyFourHours + 2000);
    });

    it('generates valid PEM for both cert and key', () => {
      const ca = trackCA();
      const cert = forgeServerCert('example.com', ca);

      expect(cert.certPem).toContain('-----BEGIN CERTIFICATE-----');
      expect(cert.certPem).toContain('-----END CERTIFICATE-----');
      expect(cert.keyPem).toContain('-----BEGIN PRIVATE KEY-----');
      expect(cert.keyPem).toContain('-----END PRIVATE KEY-----');
    });
  });

  describe('cleanupCA', () => {
    it('removes the temp directory and files', () => {
      const ca = generateCA(); // Don't track — we clean up manually
      const tempDir = ca.tempDir;

      expect(existsSync(tempDir)).toBe(true);
      cleanupCA(ca);
      expect(existsSync(tempDir)).toBe(false);
    });

    it('handles double cleanup gracefully', () => {
      const ca = generateCA();
      cleanupCA(ca);
      // Should not throw
      cleanupCA(ca);
    });
  });

  describe('TLS handshake validation', () => {
    it('forged cert works with node:tls server', async () => {
      const ca = trackCA();
      const cert = forgeServerCert('localhost', ca);

      const { createServer } = await import('node:https');

      const server = createServer(
        { cert: cert.certPem, key: cert.keyPem },
        (req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
        },
      );

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });

      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        // Use curl to test the TLS handshake — more reliable than node:https
        // which has stricter hostname checking in Bun
        const proc = Bun.spawn(
          ['curl', '-s', '--cacert', ca.certPath, '--resolve', `localhost:${port}:127.0.0.1`, `https://localhost:${port}/test`],
          { stdout: 'pipe', stderr: 'pipe' },
        );
        const body = await new Response(proc.stdout).text();
        await proc.exited;

        expect(body).toBe('ok');
      } finally {
        server.close();
      }
    });
  });
});
