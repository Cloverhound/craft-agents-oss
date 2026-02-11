/**
 * esbuild Subprocess Compilation
 *
 * Runs esbuild.build() in a forked Node process to avoid bundling issues.
 *
 * Why? In electron:start (and production), the main process is bundled into a
 * single CJS file. esbuild's JS API breaks when bundled because it can't locate
 * its native binary. Forking a real Node process lets require("esbuild") resolve
 * naturally from node_modules.
 *
 * Extracted as an additive module to keep compiler.ts close to upstream and
 * reduce merge conflict surface. (craft-agents-oss-development)
 */

import { spawn } from 'child_process';
import type { BuildOptions } from 'esbuild';

/**
 * Tiny Node.js script passed to `node -e`.
 * Options arrive via the _ESBUILD_OPTS environment variable (JSON).
 * Build errors are written to stderr as a JSON string array.
 */
const ESBUILD_SUBPROCESS_SCRIPT = [
  'const opts = JSON.parse(process.env._ESBUILD_OPTS);',
  'require("esbuild").build(opts).then(result => {',
  '  if (result.errors.length > 0) {',
  '    process.stderr.write(JSON.stringify(result.errors.map(e => e.text)));',
  '    process.exit(1);',
  '  }',
  '}).catch(err => {',
  '  process.stderr.write(err.message || "esbuild compilation failed");',
  '  process.exit(1);',
  '});',
].join('\n');

/**
 * Compile app source via esbuild in a subprocess.
 *
 * Matches the compileTailwind() pattern in compiler.ts: spawn a child process,
 * capture stderr, resolve with structured result.
 *
 * @param appPath   - Absolute path to the app directory (used as cwd)
 * @param options   - esbuild BuildOptions (from buildEsbuildOptions)
 * @param nodePaths - Host node_modules paths so the subprocess can find esbuild
 */
export async function compileEsbuildViaSubprocess(
  appPath: string,
  options: BuildOptions,
  nodePaths: string[],
): Promise<{ success: boolean; errors: string[] }> {
  // Merge host paths with any existing NODE_PATH so the subprocess
  // can require("esbuild") even though appPath is outside the project tree.
  const existingNodePath = process.env.NODE_PATH || '';
  const nodePath = [...nodePaths, ...existingNodePath.split(':').filter(Boolean)].join(':');

  return new Promise((resolve) => {
    const proc = spawn('node', ['-e', ESBUILD_SUBPROCESS_SCRIPT], {
      cwd: appPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        _ESBUILD_OPTS: JSON.stringify(options),
        NODE_PATH: nodePath,
      },
    });

    const stderrChunks: Buffer[] = [];
    proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on('close', (exitCode) => {
      if (exitCode !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        // Try to parse structured error array from our script
        let errors: string[];
        try {
          errors = JSON.parse(stderr);
          if (!Array.isArray(errors)) throw 0;
        } catch {
          errors = [stderr || 'esbuild compilation failed'];
        }
        resolve({ success: false, errors });
      } else {
        resolve({ success: true, errors: [] });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, errors: [err.message] });
    });
  });
}
