/**
 * Build auth-curl for production bundling.
 *
 * Compiles packages/auth-curl/src/cli.ts into a single JS file and creates
 * platform-specific wrapper scripts in apps/electron/vendor/auth-curl/.
 *
 * The wrapper scripts use the vendored Bun runtime (vendor/bun/) so auth-curl
 * works without any global installation.
 */

import { spawn } from "bun";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";

const ROOT_DIR = join(import.meta.dir, "..");
const VENDOR_DIR = join(ROOT_DIR, "apps/electron/vendor/auth-curl");
const OUTPUT_FILE = join(VENDOR_DIR, "cli.js");

async function main(): Promise<void> {
  // Ensure vendor directory exists
  mkdirSync(VENDOR_DIR, { recursive: true });

  console.log("🔨 Building auth-curl...");

  // Bundle auth-curl CLI into a single JS file
  const proc = spawn({
    cmd: [
      "bun", "run", "esbuild",
      "packages/auth-curl/src/cli.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      `--outfile=${OUTPUT_FILE}`,
      // Mark zod as external (provided by the environment)
      "--external:zod",
    ],
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error("❌ auth-curl build failed with exit code", exitCode);
    process.exit(exitCode);
  }

  if (!existsSync(OUTPUT_FILE)) {
    console.error("❌ auth-curl output not found at", OUTPUT_FILE);
    process.exit(1);
  }

  // Create Unix wrapper script (macOS/Linux)
  // Uses relative path to vendored bun (../bun/bun)
  const unixWrapper = `#!/bin/bash
# auth-curl — curl wrapper with automatic credential injection
# Uses the vendored Bun runtime bundled with the app
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/../bun/bun" "$SCRIPT_DIR/cli.js" "$@"
`;
  writeFileSync(join(VENDOR_DIR, "auth-curl"), unixWrapper);
  chmodSync(join(VENDOR_DIR, "auth-curl"), 0o755);

  // Create Windows wrapper script
  const winWrapper = `@echo off
:: auth-curl — curl wrapper with automatic credential injection
:: Uses the vendored Bun runtime bundled with the app
set "SCRIPT_DIR=%~dp0"
"%SCRIPT_DIR%..\\bun\\bun.exe" "%SCRIPT_DIR%cli.js" %*
`;
  writeFileSync(join(VENDOR_DIR, "auth-curl.cmd"), winWrapper);

  console.log("✅ auth-curl built and wrapped");
  process.exit(0);
}

main();
