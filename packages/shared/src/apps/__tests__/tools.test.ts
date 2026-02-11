import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';
import { createAppCreateTool, createAppCompileTool, createAppPreviewTool } from '../app-tools.ts';

/** Extract text from a CallToolResult content item */
function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0];
  if (item && 'text' in item && typeof item.text === 'string') return item.text;
  throw new Error('Expected text content');
}

function createArgs(overrides: {
  slug: string;
  name: string;
  views: Array<{ id: string; path: string; title: string; script?: string }>;
  description?: string;
  icon?: string;
  credentials?: string[];
  mode?: 'explore' | 'execute';
}) {
  return {
    slug: overrides.slug,
    name: overrides.name,
    description: overrides.description as string | undefined,
    icon: overrides.icon as string | undefined,
    views: overrides.views,
    credentials: overrides.credentials as string[] | undefined,
    mode: overrides.mode as 'explore' | 'execute' | undefined,
  };
}

describe('app_create tool', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'app-tools-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it('creates app directory and returns success for valid config', async () => {
    const tool = createAppCreateTool('session-1', tempDir);
    const result = await tool.handler(createArgs({
      slug: 'test-app',
      name: 'Test App',
      views: [{ id: 'main', path: '/main', title: 'Main View' }],
    }), undefined);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(getText(result));
    expect(parsed.success).toBe(true);
    expect(parsed.slug).toBe('test-app');
    expect(parsed.appPath).toBe(join(tempDir, 'apps', 'test-app'));
    expect(existsSync(join(tempDir, 'apps', 'test-app', 'config.json'))).toBe(true);
    expect(existsSync(join(tempDir, 'apps', 'test-app', 'src', 'App.tsx'))).toBe(true);
  });

  it('returns error for invalid slug', async () => {
    const tool = createAppCreateTool('session-1', tempDir);
    const result = await tool.handler(createArgs({
      slug: 'INVALID SLUG!',
      name: 'Bad App',
      views: [{ id: 'main', path: '/main', title: 'Main' }],
    }), undefined);

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(getText(result));
    expect(parsed.success).toBe(false);
    expect(parsed.validationErrors).toBeDefined();
  });

  it('returns error for duplicate slug', async () => {
    const tool = createAppCreateTool('session-1', tempDir);

    // Create first
    await tool.handler(createArgs({
      slug: 'my-app',
      name: 'My App',
      views: [{ id: 'main', path: '/main', title: 'Main' }],
    }), undefined);

    // Try duplicate
    const result = await tool.handler(createArgs({
      slug: 'my-app',
      name: 'My App Again',
      views: [{ id: 'main', path: '/main', title: 'Main' }],
    }), undefined);

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(getText(result));
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('already exists');
  });
});

describe('app_compile tool', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'app-compile-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it('returns error for non-existent app', async () => {
    const tool = createAppCompileTool('session-1', tempDir);
    const result = await tool.handler({ appSlug: 'nonexistent' }, undefined);

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(getText(result));
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('not found');
  });

  it('compiles a scaffolded app successfully', async () => {
    // First create an app
    const createTool = createAppCreateTool('session-1', tempDir);
    await createTool.handler(createArgs({
      slug: 'compile-test',
      name: 'Compile Test',
      views: [{ id: 'main', path: '/main', title: 'Main View' }],
    }), undefined);

    // Then compile it
    const compileTool = createAppCompileTool('session-1', tempDir);
    const result = await compileTool.handler({ appSlug: 'compile-test' }, undefined);

    const parsed = JSON.parse(getText(result));
    expect(parsed.success).toBe(true);
    expect(parsed.buildTimeMs).toBeGreaterThan(0);

    // Verify dist output
    expect(existsSync(join(tempDir, 'apps', 'compile-test', 'dist', 'bundle.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'apps', 'compile-test', 'dist', 'index.html'))).toBe(true);
  });
});

describe('app_preview tool', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'app-preview-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it('calls the onAppPreview callback with correct slug', async () => {
    // First create an app
    const createTool = createAppCreateTool('session-1', tempDir);
    await createTool.handler(createArgs({
      slug: 'preview-app',
      name: 'Preview App',
      views: [{ id: 'main', path: '/main', title: 'Main' }],
    }), undefined);

    // Set up callback tracking
    let previewedSlug: string | null = null;
    const getCallbacks = (_sessionId: string) => ({
      onAppPreview: (slug: string) => {
        previewedSlug = slug;
      },
    });

    const previewTool = createAppPreviewTool('session-1', tempDir, getCallbacks, 'session-1');
    const result = await previewTool.handler({ appSlug: 'preview-app' }, undefined);

    const parsed = JSON.parse(getText(result));
    expect(parsed.success).toBe(true);
    expect(previewedSlug).not.toBeNull();
    expect(previewedSlug!).toBe('preview-app');
  });

  it('returns error for non-existent app', async () => {
    const getCallbacks = () => ({});
    const tool = createAppPreviewTool('session-1', tempDir, getCallbacks, 'session-1');
    const result = await tool.handler({ appSlug: 'nonexistent' }, undefined);

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(getText(result));
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('not found');
  });
});
