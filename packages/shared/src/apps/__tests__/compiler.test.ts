import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';
import { buildEsbuildOptions, generateIndexHtml, compileApp } from '../compiler.ts';
import { scaffoldApp } from '../scaffold.ts';
import type { AppConfig } from '../types.ts';

describe('Compiler', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'compiler-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  describe('buildEsbuildOptions', () => {
    it('returns correct config shape', () => {
      const opts = buildEsbuildOptions('/tmp/my-app');
      expect(opts.entryPoints).toEqual(['/tmp/my-app/src/main.tsx']);
      expect(opts.format).toBe('esm');
      expect(opts.bundle).toBe(true);
      expect(opts.outfile).toBe('/tmp/my-app/dist/bundle.js');
    });

    it('bundles react and app-sdk (no externals)', () => {
      const opts = buildEsbuildOptions('/tmp/my-app');
      expect(opts.external).toBeUndefined();
      // Should have nodePaths so esbuild can find react/react-dom
      expect(opts.nodePaths).toBeDefined();
      expect(opts.nodePaths!.length).toBeGreaterThan(0);
    });

    it('sets jsx to automatic', () => {
      const opts = buildEsbuildOptions('/tmp/my-app');
      expect(opts.jsx).toBe('automatic');
    });
  });

  describe('generateIndexHtml', () => {
    it('contains <div id="root">', () => {
      const html = generateIndexHtml('my-app');
      expect(html).toContain('<div id="root"></div>');
    });

    it('references bundle.js', () => {
      const html = generateIndexHtml('my-app');
      expect(html).toContain('bundle.js');
    });

    it('references styles.css', () => {
      const html = generateIndexHtml('my-app');
      expect(html).toContain('styles.css');
    });

    it('contains <script> tag', () => {
      const html = generateIndexHtml('my-app');
      expect(html).toContain('<script');
    });

    it('contains <link> tag', () => {
      const html = generateIndexHtml('my-app');
      expect(html).toContain('<link');
    });
  });

  describe('compileApp (integration)', () => {
    const config: AppConfig = {
      slug: 'test-app',
      name: 'Test App',
      views: [{ id: 'main', path: '/', title: 'Main' }],
    };

    it('compiles a scaffolded app successfully', async () => {
      const appDir = scaffoldApp(tempDir, config);
      const result = await compileApp(appDir);

      // If compilation failed, show errors for debugging
      if (!result.success) {
        console.error('Compile errors:', result.errors);
      }

      expect(result.success).toBe(true);
      expect(result.buildTimeMs).toBeGreaterThan(0);
      expect(existsSync(join(appDir, 'dist', 'bundle.js'))).toBe(true);
      expect(existsSync(join(appDir, 'dist', 'index.html'))).toBe(true);
    });

    it('generates valid index.html in dist/', async () => {
      const appDir = scaffoldApp(tempDir, config);
      await compileApp(appDir);

      const html = readFileSync(join(appDir, 'dist', 'index.html'), 'utf-8');
      expect(html).toContain('<div id="root">');
      expect(html).toContain('bundle.js');
      expect(html).toContain('styles.css');
    });

    it('returns failure for app with syntax error', async () => {
      const appDir = scaffoldApp(tempDir, config);
      // Overwrite App.tsx with invalid syntax
      writeFileSync(join(appDir, 'src', 'App.tsx'), 'export default function App() { return <div>unclosed', 'utf-8');

      const result = await compileApp(appDir);
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });
  });
});
