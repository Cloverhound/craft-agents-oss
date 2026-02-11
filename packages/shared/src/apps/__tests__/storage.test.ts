import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getWorkspaceAppsPath,
  loadAppConfig,
  loadAllApps,
  deleteApp,
} from '../storage.ts';

describe('App Storage', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'app-storage-test-'));
  });

  afterEach(() => {
    try {
      const { rmSync } = require('fs');
      rmSync(tempDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  const validConfig = {
    slug: 'test-app',
    name: 'Test App',
    views: [{ id: 'list', path: '/list', title: 'List View' }],
  };

  function createApp(slug: string, config: Record<string, unknown>): void {
    const appDir = join(tempDir, 'apps', slug);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'config.json'), JSON.stringify(config));
  }

  describe('getWorkspaceAppsPath', () => {
    it('returns correct path', () => {
      expect(getWorkspaceAppsPath('/workspace')).toBe('/workspace/apps');
    });
  });

  describe('loadAppConfig', () => {
    it('returns null for missing config', () => {
      const result = loadAppConfig(tempDir, 'nonexistent');
      expect(result).toBeNull();
    });

    it('parses valid config.json', () => {
      createApp('test-app', validConfig);
      const result = loadAppConfig(tempDir, 'test-app');
      expect(result).not.toBeNull();
      expect(result!.slug).toBe('test-app');
      expect(result!.name).toBe('Test App');
      expect(result!.views).toHaveLength(1);
    });

    it('returns null for invalid JSON', () => {
      const appDir = join(tempDir, 'apps', 'bad-json');
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, 'config.json'), 'not json{{{');
      const result = loadAppConfig(tempDir, 'bad-json');
      expect(result).toBeNull();
    });

    it('returns null for invalid config structure', () => {
      createApp('bad-config', { name: 'Missing slug and views' });
      const result = loadAppConfig(tempDir, 'bad-config');
      expect(result).toBeNull();
    });
  });

  describe('loadAllApps', () => {
    it('returns empty array for missing apps/ dir', () => {
      const result = loadAllApps(tempDir);
      expect(result).toEqual([]);
    });

    it('scans multiple app directories', () => {
      createApp('app-a', { ...validConfig, slug: 'app-a', name: 'App A' });
      createApp('app-b', { ...validConfig, slug: 'app-b', name: 'App B' });
      const result = loadAllApps(tempDir);
      expect(result).toHaveLength(2);
      const slugs = result.map((a) => a.config.slug).sort();
      expect(slugs).toEqual(['app-a', 'app-b']);
    });

    it('sets isBuilt: true when dist/index.html exists', () => {
      createApp('built-app', validConfig);
      const distDir = join(tempDir, 'apps', 'built-app', 'dist');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, 'index.html'), '<html></html>');
      const result = loadAllApps(tempDir);
      expect(result).toHaveLength(1);
      expect(result[0]!.isBuilt).toBe(true);
    });

    it('sets isBuilt: false when dist/ does not exist', () => {
      createApp('unbuilt-app', { ...validConfig, slug: 'unbuilt-app' });
      const result = loadAllApps(tempDir);
      expect(result).toHaveLength(1);
      expect(result[0]!.isBuilt).toBe(false);
    });

    it('skips directories with invalid configs', () => {
      createApp('good', validConfig);
      createApp('bad', { name: 'No slug' });
      const result = loadAllApps(tempDir);
      expect(result).toHaveLength(1);
      expect(result[0]!.config.slug).toBe('test-app');
    });

    it('includes correct folderPath', () => {
      createApp('my-app', { ...validConfig, slug: 'my-app' });
      const result = loadAllApps(tempDir);
      expect(result[0]!.folderPath).toBe(join(tempDir, 'apps', 'my-app'));
    });
  });

  describe('deleteApp', () => {
    it('removes the app directory', () => {
      createApp('to-delete', { ...validConfig, slug: 'to-delete' });
      const appPath = join(tempDir, 'apps', 'to-delete');
      expect(existsSync(appPath)).toBe(true);
      const result = deleteApp(tempDir, 'to-delete');
      expect(result).toBe(true);
      expect(existsSync(appPath)).toBe(false);
    });

    it('returns false for non-existent app', () => {
      const result = deleteApp(tempDir, 'no-such-app');
      expect(result).toBe(false);
    });
  });
});
