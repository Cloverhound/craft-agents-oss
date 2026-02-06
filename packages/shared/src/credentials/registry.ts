/**
 * Credential Registry
 *
 * Loads and saves credential config files from a workspace's credentials directory.
 * Each credential is a JSON file at:
 *   ~/.craft-agent/workspaces/{ws}/credentials/{slug}.json
 *
 * These files define URL patterns and auth types. Secrets are stored
 * separately in the encrypted credential store.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { debug } from '../utils/debug.ts';
import type { CredentialConfig, LoadedCredentialConfig } from './credential-config-types.ts';

/**
 * Get the credentials directory path for a workspace
 */
export function getCredentialsDir(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'credentials');
}

/**
 * Get the config file path for a specific credential
 */
export function getCredentialConfigPath(workspaceRootPath: string, slug: string): string {
  return join(getCredentialsDir(workspaceRootPath), `${slug}.json`);
}

/**
 * Load a single credential config from disk
 */
export function loadCredentialConfig(
  workspaceRootPath: string,
  slug: string
): LoadedCredentialConfig | null {
  const configPath = getCredentialConfigPath(workspaceRootPath, slug);

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config: CredentialConfig = JSON.parse(raw);
    const workspaceId = basename(workspaceRootPath);

    return {
      ...config,
      configPath,
      workspaceRootPath,
      workspaceId,
    };
  } catch (error) {
    debug(`[CredentialRegistry] Failed to load credential config ${slug}:`, error);
    return null;
  }
}

/**
 * Load all credential configs from a workspace
 */
export function loadCredentialRegistry(workspaceRootPath: string): LoadedCredentialConfig[] {
  const credentialsDir = getCredentialsDir(workspaceRootPath);

  if (!existsSync(credentialsDir)) {
    return [];
  }

  const configs: LoadedCredentialConfig[] = [];

  try {
    const files = readdirSync(credentialsDir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const slug = file.replace(/\.json$/, '');
      const config = loadCredentialConfig(workspaceRootPath, slug);

      if (config) {
        configs.push(config);
      }
    }
  } catch (error) {
    debug(`[CredentialRegistry] Failed to read credentials directory:`, error);
  }

  return configs;
}

/**
 * Save a credential config to disk
 */
export function saveCredentialConfig(
  workspaceRootPath: string,
  config: CredentialConfig
): void {
  const credentialsDir = getCredentialsDir(workspaceRootPath);
  const configPath = getCredentialConfigPath(workspaceRootPath, config.slug);

  // Ensure credentials directory exists
  if (!existsSync(credentialsDir)) {
    mkdirSync(credentialsDir, { recursive: true });
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  debug(`[CredentialRegistry] Saved credential config: ${config.slug}`);
}

/**
 * Delete a credential config from disk
 */
export function deleteCredentialConfig(
  workspaceRootPath: string,
  slug: string
): boolean {
  const configPath = getCredentialConfigPath(workspaceRootPath, slug);

  if (!existsSync(configPath)) {
    return false;
  }

  try {
    const { unlinkSync } = require('fs');
    unlinkSync(configPath);
    debug(`[CredentialRegistry] Deleted credential config: ${slug}`);
    return true;
  } catch (error) {
    debug(`[CredentialRegistry] Failed to delete credential config ${slug}:`, error);
    return false;
  }
}

/**
 * List all credential slugs in a workspace
 */
export function listCredentialSlugs(workspaceRootPath: string): string[] {
  const credentialsDir = getCredentialsDir(workspaceRootPath);

  if (!existsSync(credentialsDir)) {
    return [];
  }

  try {
    return readdirSync(credentialsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}
