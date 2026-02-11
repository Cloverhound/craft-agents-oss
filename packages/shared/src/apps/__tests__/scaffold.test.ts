import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';
import { scaffoldApp } from '../scaffold.ts';
import { loadAllApps } from '../storage.ts';
import type { AppConfig } from '../types.ts';

describe('scaffoldApp', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scaffold-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  const basicConfig: AppConfig = {
    slug: 'my-app',
    name: 'My App',
    views: [
      { id: 'list', path: '/list', title: 'List View', script: 'fetch-list' },
      { id: 'detail', path: '/detail/:id', title: 'Detail View' },
    ],
  };

  it('creates all expected files and directories', () => {
    const appDir = scaffoldApp(tempDir, basicConfig);

    expect(existsSync(join(appDir, 'config.json'))).toBe(true);
    expect(existsSync(join(appDir, 'src', 'App.tsx'))).toBe(true);
    expect(existsSync(join(appDir, 'src', 'main.tsx'))).toBe(true);
    expect(existsSync(join(appDir, 'src', 'index.css'))).toBe(true);
    expect(existsSync(join(appDir, 'src', 'views', 'list.tsx'))).toBe(true);
    expect(existsSync(join(appDir, 'src', 'views', 'detail.tsx'))).toBe(true);
    expect(existsSync(join(appDir, 'scripts'))).toBe(true);
  });

  it('writes config.json matching input config', () => {
    const appDir = scaffoldApp(tempDir, basicConfig);
    const written = JSON.parse(readFileSync(join(appDir, 'config.json'), 'utf-8'));
    expect(written.slug).toBe('my-app');
    expect(written.name).toBe('My App');
    expect(written.views).toHaveLength(2);
    expect(written.views[0].id).toBe('list');
  });

  it('generates App.tsx with correct view imports', () => {
    scaffoldApp(tempDir, basicConfig);
    const appTsx = readFileSync(join(tempDir, 'apps', 'my-app', 'src', 'App.tsx'), 'utf-8');
    expect(appTsx).toContain("import ListView from './views/list'");
    expect(appTsx).toContain("import DetailView from './views/detail'");
    expect(appTsx).toContain("case 'list':");
    expect(appTsx).toContain("case 'detail':");
    expect(appTsx).toContain('relative z-10 min-h-screen bg-background text-foreground');
  });

  it('generates view files with correct component stubs', () => {
    scaffoldApp(tempDir, basicConfig);

    const listView = readFileSync(join(tempDir, 'apps', 'my-app', 'src', 'views', 'list.tsx'), 'utf-8');
    expect(listView).toContain('export default function ListView()');
    expect(listView).toContain("useAppData('fetch-list')");

    const detailView = readFileSync(join(tempDir, 'apps', 'my-app', 'src', 'views', 'detail.tsx'), 'utf-8');
    expect(detailView).toContain('export default function DetailView()');
    expect(detailView).not.toContain('useAppData');
    expect(detailView).toContain('Welcome to Detail View');
  });

  it('generates index.css with tailwindcss import', () => {
    scaffoldApp(tempDir, basicConfig);
    const css = readFileSync(join(tempDir, 'apps', 'my-app', 'src', 'index.css'), 'utf-8');
    expect(css).toContain('@import "tailwindcss"');
  });

  it('throws when app directory already exists', () => {
    scaffoldApp(tempDir, basicConfig);
    expect(() => scaffoldApp(tempDir, basicConfig)).toThrow('App directory already exists');
  });

  it('is findable via loadAllApps after scaffolding', () => {
    scaffoldApp(tempDir, basicConfig);
    const apps = loadAllApps(tempDir);
    expect(apps).toHaveLength(1);
    expect(apps[0]!.config.slug).toBe('my-app');
    expect(apps[0]!.isBuilt).toBe(false);
  });

  it('returns the app directory path', () => {
    const result = scaffoldApp(tempDir, basicConfig);
    expect(result).toBe(join(tempDir, 'apps', 'my-app'));
  });
});
