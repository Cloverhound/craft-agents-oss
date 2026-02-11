/**
 * App Compiler
 *
 * Compiles app source (React+Tailwind) to a dist/ folder using esbuild.
 * Broken into composable, individually testable functions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import type { CompileResult } from './types.ts';
// Subprocess esbuild — avoids bundled-context native binary issue (see module for details)
import { compileEsbuildViaSubprocess } from './esbuild-subprocess.ts';

/**
 * Resolve the node_modules paths that esbuild should use for package resolution.
 * This allows apps compiled in workspace dirs (without their own node_modules)
 * to find react, react-dom, and @craft-agent/app-sdk from the host installation.
 */
function getNodePaths(): string[] {
  const paths: string[] = [];
  try {
    // Walk up from the react package to find the node_modules dir
    const reactPath = require.resolve('react');
    let dir = dirname(reactPath);
    while (dir !== '/' && dir !== '.') {
      if (dir.endsWith('/node_modules/react') || dir.endsWith('/node_modules/.bun')) {
        paths.push(join(dir, '..'));
        break;
      }
      const parent = dirname(dir);
      if (parent.endsWith('/node_modules')) {
        paths.push(parent);
        break;
      }
      dir = parent;
    }
  } catch {
    // react not resolvable — esbuild will use its own resolution
  }
  return paths;
}

// ============================================================
// esbuild Configuration
// ============================================================

/**
 * Build esbuild options for an app.
 * Pure function — returns config, no side effects.
 */
export function buildEsbuildOptions(appPath: string): import('esbuild').BuildOptions {
  return {
    entryPoints: [join(appPath, 'src', 'main.tsx')],
    bundle: true,
    format: 'esm',
    target: ['es2022'],
    outfile: join(appPath, 'dist', 'bundle.js'),
    jsx: 'automatic',
    loader: {
      '.tsx': 'tsx',
      '.ts': 'ts',
      '.css': 'css',
    },
    nodePaths: getNodePaths(),
    minify: false,
    sourcemap: true,
    logLevel: 'silent',
  };
}

// ============================================================
// HTML Generation
// ============================================================

/**
 * Generate the index.html shell for an app.
 * Pure function — returns HTML string.
 */
export function generateIndexHtml(appSlug: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${appSlug}</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="bundle.js"></script>
</body>
</html>
`;
}

// ============================================================
// Tailwind CSS Compilation
// ============================================================

/**
 * Resolve the absolute path to tailwindcss/index.css so we can rewrite
 * `@import "tailwindcss"` to an absolute path the CLI can always find,
 * even when the app directory has no node_modules of its own.
 */
function resolveTailwindCssPath(): string | null {
  try {
    return require.resolve('tailwindcss/index.css');
  } catch {
    return null;
  }
}

/**
 * Compatibility theme tokens for scaffolded/custom apps.
 *
 * Our app templates and host UI conventions use semantic tokens like:
 * - bg-background
 * - text-foreground
 * - border-foreground/...
 * - ring-accent/...
 *
 * Tailwind only emits these utilities when the corresponding theme colors exist.
 * Injecting this block ensures those tokens always compile, while still allowing
 * runtime overrides via CSS custom properties.
 */
function getCompatibilityThemeCss(): string {
  return `
@theme {
  --color-background: var(--app-color-background, oklch(98.5% 0 0));
  --color-foreground: var(--app-color-foreground, oklch(27.4% 0.006 286.033));
  --color-accent: var(--app-color-accent, oklch(62.3% 0.214 259.815));
}

@media (prefers-color-scheme: dark) {
  :root {
    --app-color-background: oklch(21% 0.006 285.885);
    --app-color-foreground: oklch(96.7% 0.001 286.375);
    --app-color-accent: oklch(70.7% 0.165 254.624);
  }
}
`;
}

/**
 * Compile Tailwind CSS for an app.
 * Runs the Tailwind CLI to process src/index.css into dist/styles.css.
 *
 * Since apps live in workspace dirs without their own node_modules:
 * 1. `@import "tailwindcss"` is rewritten to an absolute path to tailwindcss/index.css
 * 2. `@source "./src"` is added so Tailwind scans the app's source files for classes
 *
 * Uses Node.js child_process (not Bun) for Electron compatibility.
 */
async function compileTailwind(appPath: string): Promise<{ success: boolean; error?: string }> {
  const inputCss = join(appPath, 'src', 'index.css');
  const outputCss = join(appPath, 'dist', 'styles.css');

  if (!existsSync(inputCss)) {
    // No CSS input — write empty styles
    writeFileSync(outputCss, '', 'utf-8');
    return { success: true };
  }

  // Resolve the absolute path to tailwindcss so @import works from any directory
  const tailwindCssPath = resolveTailwindCssPath();
  let actualInput = inputCss;
  let tempFile: string | null = null;

  if (tailwindCssPath) {
    let cssContent = readFileSync(inputCss, 'utf-8');
    const hasTailwindImport = cssContent.includes('@import "tailwindcss"') || cssContent.includes("@import 'tailwindcss'");
    const hasCompatibilityTheme =
      cssContent.includes('--color-background:') &&
      cssContent.includes('--color-foreground:') &&
      cssContent.includes('--color-accent:');

    if (hasTailwindImport) {
      // Rewrite the import to absolute path
      cssContent = cssContent
        .replace(/@import\s+["']tailwindcss["']/g, `@import "${tailwindCssPath}"`);

      // Inject semantic token compatibility theme so classes like bg-background
      // and border-foreground/10 compile even when app CSS doesn't define them.
      if (!hasCompatibilityTheme) {
        cssContent += `\n${getCompatibilityThemeCss()}\n`;
      }

      // Add @source directive so Tailwind scans the app's source files for classes.
      // Without this, auto-detection won't find classes in workspace app directories.
      if (!cssContent.includes('@source')) {
        cssContent += `\n@source "./src";\n`;
      }

      tempFile = join(appPath, 'src', '.index.tailwind-tmp.css');
      writeFileSync(tempFile, cssContent, 'utf-8');
      actualInput = tempFile;
    }
  }

  try {
    return await new Promise<{ success: boolean; error?: string }>((resolve) => {
      const proc = spawn(
        'bunx',
        ['--package', '@tailwindcss/cli', 'tailwindcss', '-i', actualInput, '-o', outputCss, '--minify'],
        {
          cwd: appPath,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      const stderrChunks: Buffer[] = [];
      proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      proc.on('close', (exitCode) => {
        if (exitCode !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString('utf-8');
          resolve({ success: false, error: stderr || 'Tailwind compilation failed' });
        } else {
          resolve({ success: true });
        }
      });

      proc.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });
    });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Tailwind compilation failed',
    };
  } finally {
    // Clean up temp file
    if (tempFile && existsSync(tempFile)) {
      try { unlinkSync(tempFile); } catch { /* ignore */ }
    }
  }
}

// ============================================================
// Full Compilation Pipeline
// ============================================================

/**
 * Compile an app: esbuild bundle + Tailwind CSS + index.html.
 * Orchestrates the composable steps.
 */
export async function compileApp(appPath: string): Promise<CompileResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  // Ensure dist/ exists
  const distDir = join(appPath, 'dist');
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }

  // Step 1: esbuild bundle (via subprocess — see esbuild-subprocess.ts)
  const esbuildResult = await compileEsbuildViaSubprocess(appPath, buildEsbuildOptions(appPath), getNodePaths());
  if (!esbuildResult.success) {
    errors.push(...esbuildResult.errors);
    return {
      success: false,
      errors,
      buildTimeMs: Date.now() - startTime,
    };
  }

  // Step 2: Tailwind CSS (non-fatal — app works without styles)
  const tailwindResult = await compileTailwind(appPath);
  if (!tailwindResult.success) {
    // Write empty styles.css so the HTML link doesn't 404
    const outputCss = join(distDir, 'styles.css');
    if (!existsSync(outputCss)) {
      writeFileSync(outputCss, '/* Tailwind compilation skipped */\n', 'utf-8');
    }
  }

  // Step 3: Generate index.html
  const appSlug = appPath.split('/').pop() || 'app';
  const html = generateIndexHtml(appSlug);
  writeFileSync(join(distDir, 'index.html'), html, 'utf-8');

  return {
    success: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
    buildTimeMs: Date.now() - startTime,
  };
}
