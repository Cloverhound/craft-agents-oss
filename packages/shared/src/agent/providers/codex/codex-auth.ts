/**
 * Codex Authentication Verification
 *
 * Checks whether the Codex CLI is installed and authenticated.
 * The SDK requires a valid OPENAI_API_KEY or authenticated CLI session.
 */

import { debug } from "../../../utils/debug.ts";

export interface CodexAuthStatus {
  authenticated: boolean;
  message?: string;
  installRequired?: boolean;
  cliVersion?: string;
}

export async function verifyCodexAuth(): Promise<CodexAuthStatus> {
  try {
    if (process.env.OPENAI_API_KEY) {
      debug("[CodexAuth] OPENAI_API_KEY found in environment");
      return { authenticated: true };
    }

    const proc = Bun.spawn(["codex", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    if (exitCode === 0) {
      const version = stdout.trim();
      debug(`[CodexAuth] CLI found, version: ${version}`);
      return {
        authenticated: true,
        cliVersion: version,
      };
    }

    return {
      authenticated: false,
      message: "Codex CLI found but not authenticated. Run: codex auth login",
    };
  } catch {
    return {
      authenticated: false,
      message: "Codex CLI not found. Install with: npm install -g @openai/codex",
      installRequired: true,
    };
  }
}
