/**
 * Credential URL Matcher
 *
 * Matches request URLs against credential URL patterns (glob-style).
 * Used by both the `authenticated_fetch` tool and the credential proxy
 * to determine which credential to inject.
 *
 * Pattern syntax:
 *   "https://api.xero.com/*"        → matches any path under api.xero.com
 *   "https://*.example.com/*"       → matches any subdomain of example.com
 *   "https://api.example.com/v2/*"  → matches paths under /v2/
 */

import type { LoadedCredentialConfig } from './credential-config-types.ts';

/**
 * Match a URL against a single glob pattern.
 *
 * Supports:
 * - `*` matches any sequence of chars except `/` in a path segment
 * - `/*` at the end matches the entire remaining path
 * - `*.domain.com` matches subdomains
 */
export function matchUrlPattern(pattern: string, url: string): boolean {
  // Convert glob pattern to regex
  // Escape regex special chars, then replace glob * with regex equivalent
  const regexStr = pattern
    // Escape regex special chars (except *)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    // Replace * with regex: match anything
    .replace(/\*/g, '.*');

  try {
    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(url);
  } catch {
    return false;
  }
}

/**
 * Find the first credential that matches a given URL.
 * First match wins.
 *
 * @param url - The request URL to match
 * @param registry - Array of loaded credential configs
 * @returns The matching credential config, or null if no match
 */
export function matchCredential(
  url: string,
  registry: LoadedCredentialConfig[]
): LoadedCredentialConfig | null {
  for (const cred of registry) {
    for (const pattern of cred.urlPatterns) {
      if (matchUrlPattern(pattern, url)) {
        return cred;
      }
    }
  }
  return null;
}

/**
 * Find a credential by slug (exact match).
 */
export function findCredentialBySlug(
  slug: string,
  registry: LoadedCredentialConfig[]
): LoadedCredentialConfig | null {
  return registry.find((c) => c.slug === slug) ?? null;
}
