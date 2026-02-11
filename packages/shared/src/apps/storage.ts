/**
 * App Storage
 *
 * Filesystem-based storage for workspace apps.
 *
 * Layout:
 *   {workspaceRootPath}/apps/{slug}/config.json  — app configuration
 *   {workspaceRootPath}/apps/{slug}/src/          — React source files
 *   {workspaceRootPath}/apps/{slug}/scripts/      — Data fetching scripts
 *   {workspaceRootPath}/apps/{slug}/dist/          — Compiled output
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import type { AppConfig, LoadedApp } from './types.ts';
import { validateAppConfig } from './validation.ts';

// ============================================================
// Path Utilities
// ============================================================

/**
 * Get path to workspace apps directory
 * @param workspaceRootPath - Absolute path to workspace root folder
 */
export function getWorkspaceAppsPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'apps');
}

/**
 * Get path to a specific app directory
 */
export function getAppPath(workspaceRootPath: string, appSlug: string): string {
  return join(workspaceRootPath, 'apps', appSlug);
}

/**
 * Get path to an app's config.json
 */
export function getAppConfigPath(workspaceRootPath: string, appSlug: string): string {
  return join(workspaceRootPath, 'apps', appSlug, 'config.json');
}

// ============================================================
// Load Operations
// ============================================================

/**
 * Load an app's config.json from disk.
 * Returns null if not found, invalid JSON, or fails validation.
 */
export function loadAppConfig(workspaceRootPath: string, appSlug: string): AppConfig | null {
  const configPath = getAppConfigPath(workspaceRootPath, appSlug);

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const validation = validateAppConfig(parsed);
    if (!validation.valid) {
      return null;
    }
    return parsed as AppConfig;
  } catch {
    return null;
  }
}

/**
 * Load all apps from the workspace apps directory.
 * Returns an array of LoadedApp objects, skipping invalid apps.
 */
export function loadAllApps(workspaceRootPath: string): LoadedApp[] {
  const appsDir = getWorkspaceAppsPath(workspaceRootPath);

  if (!existsSync(appsDir)) {
    return [];
  }

  const apps: LoadedApp[] = [];

  try {
    const entries = readdirSync(appsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const slug = entry.name;
      const config = loadAppConfig(workspaceRootPath, slug);
      if (!config) continue;

      const folderPath = getAppPath(workspaceRootPath, slug);
      const isBuilt = existsSync(join(folderPath, 'dist', 'index.html'));

      apps.push({ config, folderPath, isBuilt });
    }
  } catch {
    // Ignore errors scanning directory
  }

  return apps;
}

// ============================================================
// Delete Operations
// ============================================================

/**
 * Delete an app directory and all its contents.
 * Returns true if deleted, false if not found.
 */
export function deleteApp(workspaceRootPath: string, appSlug: string): boolean {
  const appPath = getAppPath(workspaceRootPath, appSlug);

  if (!existsSync(appPath)) {
    return false;
  }

  try {
    rmSync(appPath, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
