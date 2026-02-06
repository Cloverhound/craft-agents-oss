/**
 * Ephemeral Certificate Authority
 *
 * Generates a short-lived CA for MITM TLS termination.
 * The CA key and cert are written to a temp directory and cleaned up on exit.
 *
 * For each intercepted hostname, a server certificate is forged (signed by
 * the CA) and cached for the lifetime of the proxy.
 */

import { generateKeyPairSync, createSign, createPrivateKey, X509Certificate } from 'node:crypto';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ASN.1 DER encoding helpers
// These are minimal helpers to build X.509 certificates without openssl CLI

function encodeLengthDER(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  } else if (length < 0x100) {
    return Buffer.from([0x81, length]);
  } else if (length < 0x10000) {
    return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
  }
  throw new Error(`Length too large: ${length}`);
}

function encodeDERSequence(items: Buffer[]): Buffer {
  const content = Buffer.concat(items);
  return Buffer.concat([Buffer.from([0x30]), encodeLengthDER(content.length), content]);
}

function encodeDERSet(items: Buffer[]): Buffer {
  const content = Buffer.concat(items);
  return Buffer.concat([Buffer.from([0x31]), encodeLengthDER(content.length), content]);
}

function encodeDERInteger(value: Buffer | number): Buffer {
  let buf: Buffer;
  if (typeof value === 'number') {
    if (value === 0) {
      buf = Buffer.from([0]);
    } else {
      const hex = value.toString(16);
      buf = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
      // Ensure positive (leading bit 0)
      if (buf[0]! & 0x80) {
        buf = Buffer.concat([Buffer.from([0]), buf]);
      }
    }
  } else {
    buf = value;
    // Strip unnecessary leading zero bytes (DER requires minimal encoding)
    while (buf.length > 1 && buf[0] === 0) {
      buf = buf.subarray(1);
    }
    // Ensure positive (leading bit 0)
    if (buf.length > 0 && buf[0]! & 0x80) {
      buf = Buffer.concat([Buffer.from([0]), buf]);
    }
  }
  return Buffer.concat([Buffer.from([0x02]), encodeLengthDER(buf.length), buf]);
}

function encodeDEROID(oid: string): Buffer {
  const parts = oid.split('.').map(Number);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i]!;
    if (val < 128) {
      bytes.push(val);
    } else {
      const temp: number[] = [];
      temp.unshift(val & 0x7f);
      val >>= 7;
      while (val > 0) {
        temp.unshift(0x80 | (val & 0x7f));
        val >>= 7;
      }
      bytes.push(...temp);
    }
  }
  const buf = Buffer.from(bytes);
  return Buffer.concat([Buffer.from([0x06]), encodeLengthDER(buf.length), buf]);
}

function encodeDERBitString(data: Buffer): Buffer {
  // Prepend unused bits count (0)
  const content = Buffer.concat([Buffer.from([0x00]), data]);
  return Buffer.concat([Buffer.from([0x03]), encodeLengthDER(content.length), content]);
}

function encodeDEROctetString(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x04]), encodeLengthDER(data.length), data]);
}

function encodeDERUTF8String(str: string): Buffer {
  const buf = Buffer.from(str, 'utf-8');
  return Buffer.concat([Buffer.from([0x0c]), encodeLengthDER(buf.length), buf]);
}

/**
 * Encode a date for X.509 validity.
 * Per RFC 5280: dates through 2049 use UTCTime (YYMMDDHHMMSSZ, tag 0x17),
 * dates 2050+ use GeneralizedTime (YYYYMMDDHHMMSSZ, tag 0x18).
 */
function encodeDERTime(date: Date): Buffer {
  const year = date.getUTCFullYear();
  if (year < 2050) {
    // UTCTime: YYMMDDHHMMSSZ
    const yy = String(year % 100).padStart(2, '0');
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const min = String(date.getUTCMinutes()).padStart(2, '0');
    const ss = String(date.getUTCSeconds()).padStart(2, '0');
    const s = `${yy}${mm}${dd}${hh}${min}${ss}Z`;
    const buf = Buffer.from(s, 'ascii');
    return Buffer.concat([Buffer.from([0x17]), encodeLengthDER(buf.length), buf]);
  } else {
    // GeneralizedTime: YYYYMMDDHHMMSSZ
    const s = date.toISOString().replace(/[-:T]/g, '').replace(/\.\d+Z$/, 'Z');
    const buf = Buffer.from(s, 'ascii');
    return Buffer.concat([Buffer.from([0x18]), encodeLengthDER(buf.length), buf]);
  }
}

function encodeDERContextTag(tag: number, data: Buffer, constructed = true): Buffer {
  const tagByte = (constructed ? 0xa0 : 0x80) | tag;
  return Buffer.concat([Buffer.from([tagByte]), encodeLengthDER(data.length), data]);
}

function encodeDERBoolean(value: boolean): Buffer {
  return Buffer.concat([Buffer.from([0x01, 0x01, value ? 0xff : 0x00])]);
}

// OIDs
const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const OID_SHA256_RSA = '1.2.840.113549.1.1.11';
const OID_COMMON_NAME = '2.5.4.3';
const OID_ORGANIZATION = '2.5.4.10';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';

/** Build a distinguished name (CN + O) */
function buildDN(cn: string, org?: string): Buffer {
  const rdns: Buffer[] = [
    encodeDERSet([
      encodeDERSequence([encodeDEROID(OID_COMMON_NAME), encodeDERUTF8String(cn)]),
    ]),
  ];
  if (org) {
    rdns.push(
      encodeDERSet([
        encodeDERSequence([encodeDEROID(OID_ORGANIZATION), encodeDERUTF8String(org)]),
      ]),
    );
  }
  return encodeDERSequence(rdns);
}

/** Build a validity period */
function buildValidity(notBefore: Date, notAfter: Date): Buffer {
  return encodeDERSequence([
    encodeDERTime(notBefore),
    encodeDERTime(notAfter),
  ]);
}

/** Extract the public key from a PEM-encoded key */
function extractPublicKeyDER(publicKeyPem: string): Buffer {
  const b64 = publicKeyPem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s/g, '');
  return Buffer.from(b64, 'base64');
}

/** Sign a TBS certificate and wrap in the final Certificate structure */
function signCertificate(tbsCertificate: Buffer, privateKeyPem: string): Buffer {
  const signatureAlgorithm = encodeDERSequence([
    encodeDEROID(OID_SHA256_RSA),
    Buffer.from([0x05, 0x00]), // NULL
  ]);

  const signer = createSign('SHA256');
  signer.update(tbsCertificate);
  const signature = signer.sign(privateKeyPem);

  return encodeDERSequence([
    tbsCertificate,
    signatureAlgorithm,
    encodeDERBitString(signature),
  ]);
}

/** Convert DER certificate to PEM */
function derToPem(der: Buffer, label: string): string {
  const b64 = der.toString('base64');
  const lines: string[] = [`-----BEGIN ${label}-----`];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  lines.push(`-----END ${label}-----`, '');
  return lines.join('\n');
}

export interface CACert {
  /** PEM-encoded CA certificate */
  certPem: string;
  /** PEM-encoded CA private key */
  keyPem: string;
  /** Path to CA cert file on disk */
  certPath: string;
  /** Path to CA key file on disk */
  keyPath: string;
  /** Temp directory containing CA files */
  tempDir: string;
}

export interface ForgedCert {
  /** PEM-encoded server certificate */
  certPem: string;
  /** PEM-encoded server private key */
  keyPem: string;
}

/**
 * Generate an ephemeral CA certificate.
 * Key and cert are written to a temp directory for CA bundle generation.
 */
export function generateCA(): CACert {
  // Generate RSA 2048-bit key pair for CA
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const publicKeyDer = extractPublicKeyDER(publicKeyPem);

  const now = new Date();
  const expiry = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours

  // Serial number (random)
  const serial = Buffer.from(Array.from({ length: 8 }, () => Math.floor(Math.random() * 256)));

  // Build TBS Certificate
  const signatureAlgorithm = encodeDERSequence([
    encodeDEROID(OID_SHA256_RSA),
    Buffer.from([0x05, 0x00]), // NULL
  ]);

  // Basic Constraints: CA=true
  const basicConstraints = encodeDERSequence([
    encodeDEROID(OID_BASIC_CONSTRAINTS),
    encodeDERBoolean(true), // critical
    encodeDEROctetString(
      encodeDERSequence([encodeDERBoolean(true)]) // cA = TRUE
    ),
  ]);

  // Key Usage: keyCertSign, cRLSign (bits 5 and 6)
  const keyUsage = encodeDERSequence([
    encodeDEROID(OID_KEY_USAGE),
    encodeDERBoolean(true), // critical
    encodeDEROctetString(
      encodeDERBitString(Buffer.from([0x06])) // keyCertSign + cRLSign
    ),
  ]);

  const extensions = encodeDERContextTag(3, encodeDERSequence([basicConstraints, keyUsage]));

  const issuerDN = buildDN('Craft Agent Credential Proxy CA', 'Craft Agent');
  const tbsCertificate = encodeDERSequence([
    encodeDERContextTag(0, encodeDERInteger(2)), // version 3
    encodeDERInteger(serial),
    signatureAlgorithm,
    issuerDN, // issuer = subject (self-signed)
    buildValidity(now, expiry),
    issuerDN, // subject
    publicKeyDer, // subjectPublicKeyInfo (already DER-encoded from SPKI)
    extensions,
  ]);

  const certDer = signCertificate(tbsCertificate, privateKeyPem);
  const certPem = derToPem(certDer, 'CERTIFICATE');

  // Write to temp directory
  const tempDir = join(tmpdir(), `craft-proxy-ca-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(tempDir, { recursive: true });

  const certPath = join(tempDir, 'ca.crt');
  const keyPath = join(tempDir, 'ca.key');
  writeFileSync(certPath, certPem, 'utf-8');
  writeFileSync(keyPath, privateKeyPem, { mode: 0o600 }); // Private key - owner only

  return { certPem, keyPem: privateKeyPem, certPath, keyPath, tempDir };
}

/**
 * Forge a server certificate for a given hostname, signed by the CA.
 * The cert includes the hostname in both CN and Subject Alternative Name.
 */
export function forgeServerCert(hostname: string, ca: CACert): ForgedCert {
  // Generate RSA 2048-bit key pair for server
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const publicKeyDer = extractPublicKeyDER(publicKeyPem);

  const now = new Date();
  const expiry = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours

  const serial = Buffer.from(Array.from({ length: 8 }, () => Math.floor(Math.random() * 256)));

  const signatureAlgorithm = encodeDERSequence([
    encodeDEROID(OID_SHA256_RSA),
    Buffer.from([0x05, 0x00]),
  ]);

  // Subject Alternative Name: dNSName
  const hostnameBytes = Buffer.from(hostname, 'ascii');
  const sanValue = encodeDERContextTag(2, hostnameBytes, false); // dNSName [2]
  const san = encodeDERSequence([
    encodeDEROID(OID_SUBJECT_ALT_NAME),
    encodeDEROctetString(encodeDERSequence([sanValue])),
  ]);

  const extensions = encodeDERContextTag(3, encodeDERSequence([san]));

  const issuerDN = buildDN('Craft Agent Credential Proxy CA', 'Craft Agent');
  const subjectDN = buildDN(hostname);

  const tbsCertificate = encodeDERSequence([
    encodeDERContextTag(0, encodeDERInteger(2)), // version 3
    encodeDERInteger(serial),
    signatureAlgorithm,
    issuerDN,
    buildValidity(now, expiry),
    subjectDN,
    publicKeyDer,
    extensions,
  ]);

  const certDer = signCertificate(tbsCertificate, ca.keyPem);
  const certPem = derToPem(certDer, 'CERTIFICATE');

  return { certPem, keyPem: privateKeyPem };
}

/**
 * Clean up CA temp directory.
 */
export function cleanupCA(ca: CACert): void {
  try {
    if (existsSync(ca.tempDir)) {
      rmSync(ca.tempDir, { recursive: true, force: true });
    }
  } catch {
    // Best effort cleanup
  }
}
