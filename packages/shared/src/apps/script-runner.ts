/**
 * App Script Runner
 *
 * Executes app data-fetching scripts in a child process.
 * Scripts output JSON to stdout, which is parsed and returned.
 *
 * Uses Node.js child_process (not Bun APIs) so it works when
 * bundled into the Electron main process.
 */

import { spawn } from 'child_process';

// ============================================================
// Types
// ============================================================

export interface RunScriptOptions {
  /** Absolute path to the script file */
  scriptPath: string;
  /** Parameters passed as JSON in CRAFT_PARAMS env var */
  params?: Record<string, string>;
  /** Additional environment variables for the child process */
  env?: Record<string, string>;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Working directory for the script */
  cwd?: string;
  /** Path to the bun binary (optional — defaults to 'bun' on PATH) */
  bunPath?: string;
}

export interface ScriptResult {
  /** Whether the script ran successfully */
  success: boolean;
  /** Parsed JSON from stdout */
  result?: unknown;
  /** Captured stderr */
  stderr?: string;
  /** Process exit code */
  exitCode: number;
}

// ============================================================
// Runner
// ============================================================

/**
 * Run an app script and parse its JSON output.
 *
 * The script is executed with `bun run` in a child process.
 * Parameters are passed via the CRAFT_PARAMS environment variable as JSON,
 * and also as individual PARAM_{KEY} (uppercased) env vars.
 * The script should output JSON to stdout.
 */
export async function runAppScript(options: RunScriptOptions): Promise<ScriptResult> {
  const { scriptPath, params, env, timeout = 30_000, cwd, bunPath } = options;

  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...env,
  };

  if (params) {
    childEnv.CRAFT_PARAMS = JSON.stringify(params);
    // Also expose each param as PARAM_{KEY} (uppercased) for simple scripts
    for (const [key, value] of Object.entries(params)) {
      childEnv[`PARAM_${key.toUpperCase()}`] = value;
    }
  }

  const runtime = bunPath || 'bun';

  try {
    return await new Promise<ScriptResult>((resolve) => {
      const proc = spawn(runtime, ['run', scriptPath], {
        cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      const timer = setTimeout(() => {
        proc.kill();
        resolve({
          success: false,
          stderr: `Script timed out after ${timeout}ms`,
          exitCode: -1,
        });
      }, timeout);

      proc.on('close', (exitCode) => {
        clearTimeout(timer);

        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');

        if (exitCode !== 0) {
          resolve({
            success: false,
            stderr: stderr || undefined,
            exitCode: exitCode ?? 1,
          });
          return;
        }

        // Parse stdout as JSON
        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve({
            success: true,
            result: null,
            exitCode: 0,
          });
          return;
        }

        try {
          const result = JSON.parse(trimmed);
          resolve({
            success: true,
            result,
            stderr: stderr || undefined,
            exitCode: 0,
          });
        } catch {
          resolve({
            success: false,
            stderr: `Failed to parse script output as JSON: ${trimmed.substring(0, 200)}`,
            exitCode: 0,
          });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          stderr: err.message,
          exitCode: -1,
        });
      });
    });
  } catch (error) {
    return {
      success: false,
      stderr: error instanceof Error ? error.message : 'Script execution failed',
      exitCode: -1,
    };
  }
}
