#!/usr/bin/env bun
/**
 * auth-curl CLI
 *
 * A thin wrapper around `curl` that auto-injects authentication headers
 * from the Craft Agent credential registry.
 *
 * Usage:
 *   auth-curl https://api.xero.com/api.xro/2.0/Invoices
 *   # equivalent to: curl -H "Authorization: Bearer {token}" https://api.xero.com/...
 *
 * Extra flags:
 *   --credential SLUG    Force a specific credential (skip URL matching)
 *   --no-auth            Skip credential injection
 *   --dry-run            Print the curl command (auth redacted)
 */

import { execFileSync } from 'child_process';
import type { OAuth2AuthConfig } from '@craft-agent/shared/credentials/credential-config-types';
import {
  findWorkspaceRootPath,
  loadRegistry,
  matchUrl,
  buildAuthFlags,
  loadSecret,
  loadOAuthToken,
} from './core.ts';

async function main() {
  const args = process.argv.slice(2);

  // Parse auth-curl specific flags
  let forceSlug: string | undefined;
  let noAuth = false;
  let dryRun = false;
  const curlArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--credential' && i + 1 < args.length) {
      forceSlug = args[++i];
    } else if (args[i] === '--no-auth') {
      noAuth = true;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else {
      curlArgs.push(args[i]!);
    }
  }

  if (curlArgs.length === 0) {
    console.error('Usage: auth-curl [options] <url> [curl-args...]');
    console.error('');
    console.error('Options:');
    console.error('  --credential SLUG  Force a specific credential');
    console.error('  --no-auth          Skip credential injection');
    console.error('  --dry-run          Print the curl command (auth redacted)');
    process.exit(1);
  }

  // If --no-auth, just pass through to curl
  if (noAuth) {
    if (dryRun) {
      console.log(`curl ${curlArgs.join(' ')}`);
      return;
    }
    try {
      const result = execFileSync('curl', curlArgs, { stdio: 'inherit' });
    } catch (e: any) {
      process.exit(e.status ?? 1);
    }
    return;
  }

  // Find workspace
  const workspacePath = findWorkspaceRootPath();
  if (!workspacePath) {
    console.error('auth-curl: No Craft Agent workspace found.');
    console.error('Set CRAFT_WORKSPACE_ROOT or configure ~/.craft-agent/config.json');
    // Fall through to plain curl
    try {
      execFileSync('curl', curlArgs, { stdio: 'inherit' });
    } catch (e: any) {
      process.exit(e.status ?? 1);
    }
    return;
  }

  // Load credential registry
  const registry = loadRegistry(workspacePath);

  // Find URL in args (first arg that looks like a URL)
  let urlIndex = curlArgs.findIndex((a) => /^https?:\/\//i.test(a));
  if (urlIndex === -1) {
    // URL might not be present yet (error), just pass through
    try {
      execFileSync('curl', curlArgs, { stdio: 'inherit' });
    } catch (e: any) {
      process.exit(e.status ?? 1);
    }
    return;
  }

  let url = curlArgs[urlIndex]!;

  // Match credential
  let credential = forceSlug
    ? registry.find((c) => c.slug === forceSlug) ?? null
    : matchUrl(url, registry);

  if (!credential) {
    // No matching credential — pass through to curl unauthenticated
    if (dryRun) {
      console.log(`curl ${curlArgs.join(' ')}`);
      console.log('# No matching credential found');
      return;
    }
    try {
      execFileSync('curl', curlArgs, { stdio: 'inherit' });
    } catch (e: any) {
      process.exit(e.status ?? 1);
    }
    return;
  }

  // Check Explore mode restrictions
  const permissionMode = process.env.CRAFT_PERMISSION_MODE;
  if (permissionMode === 'explore' || permissionMode === 'safe') {
    const allowedMethods = credential.permissions?.explore?.methods ?? ['GET'];
    // Detect HTTP method from curl args
    const methodFlagIndex = curlArgs.findIndex((a) => a === '-X' || a === '--request');
    const method = methodFlagIndex >= 0 && methodFlagIndex + 1 < curlArgs.length
      ? curlArgs[methodFlagIndex + 1]!.toUpperCase()
      : 'GET'; // curl defaults to GET

    if (!allowedMethods.includes(method)) {
      console.error(`auth-curl: Method ${method} not allowed in Explore mode for '${credential.slug}'.`);
      console.error(`Allowed methods: ${allowedMethods.join(', ')}`);
      process.exit(1);
    }
  }

  // Load secret
  let secretValue: string | null = null;

  if (credential.auth.type === 'oauth2') {
    secretValue = await loadOAuthToken(
      credential.workspaceId,
      credential.slug,
      credential.auth as OAuth2AuthConfig
    );
  } else {
    secretValue = await loadSecret(
      credential.workspaceId,
      credential.slug,
      credential.auth.type
    );
  }

  if (!secretValue) {
    console.error(`auth-curl: No credentials found for '${credential.slug}'.`);
    console.error('Run credential setup first.');
    process.exit(1);
  }

  // Build auth flags
  const { flags: authFlags, url: modifiedUrl } = buildAuthFlags(
    credential.auth,
    secretValue,
    url
  );

  // Update URL in args if it was modified (query param auth)
  if (modifiedUrl !== url) {
    curlArgs[urlIndex] = modifiedUrl;
  }

  // Combine auth flags with original curl args
  const finalArgs = [...authFlags, ...curlArgs];

  if (dryRun) {
    // Redact auth values in dry-run output
    const redactedArgs = finalArgs.map((a, i) => {
      // Redact the value after -H, --user flags
      if (i > 0 && (finalArgs[i - 1] === '-H' || finalArgs[i - 1] === '--user')) {
        const colonIndex = a.indexOf(':');
        if (colonIndex > 0) {
          return `${a.substring(0, colonIndex + 1)} [REDACTED]`;
        }
        return '[REDACTED]';
      }
      return a;
    });
    console.log(`curl ${redactedArgs.join(' ')}`);
    console.log(`# Credential: ${credential.slug} (${credential.auth.type})`);
    return;
  }

  // Execute curl with auth
  try {
    execFileSync('curl', finalArgs, { stdio: 'inherit' });
  } catch (e: any) {
    process.exit(e.status ?? 1);
  }
}

main().catch((error) => {
  console.error('auth-curl error:', error.message || error);
  process.exit(1);
});
