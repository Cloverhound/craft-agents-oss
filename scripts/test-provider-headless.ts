#!/usr/bin/env bun
/**
 * E2E validation script for the provider abstraction layer.
 *
 * Runs a simple headless query through CraftAgent (which now delegates
 * to ClaudeAgent internally) to verify the refactoring doesn't break
 * the end-to-end flow.
 *
 * Usage:
 *   bun scripts/test-provider-headless.ts [workspace-path]
 *
 * Requires a valid API key configured in ~/.craft-agent/config.json
 */

import { HeadlessRunner } from "../packages/shared/src/headless/runner.ts";
import type { HeadlessConfig } from "../packages/shared/src/headless/types.ts";
import { createProvider, getSupportedProviders, getProviderDisplayName } from "../packages/shared/src/agent/providers/index.ts";

const workspacePath = process.argv[2] || process.cwd();

console.log("=== Provider Abstraction E2E Test ===\n");

console.log("1. Provider Factory:");
for (const type of getSupportedProviders()) {
  console.log(`   - ${getProviderDisplayName(type)} (${type})`);
  const provider = createProvider(type);
  console.log(`     type: ${provider.type}`);
  console.log(`     features: extended_thinking=${provider.supports("extended_thinking")}, vision=${provider.supports("vision")}`);
}

console.log("\n2. Headless Execution (via CraftAgent → ClaudeAgent):");

const config: HeadlessConfig = {
  prompt: "What is 2+2? Reply with just the number.",
  workspace: {
    id: "test-provider",
    name: "Test Provider",
    rootPath: workspacePath,
  },
  permissionPolicy: "deny-all",
  provider: "claude",
};

const runner = new HeadlessRunner(config);

try {
  let eventCount = 0;
  for await (const event of runner.runStreaming()) {
    eventCount++;
    switch (event.type) {
      case "status":
        console.log(`   [status] ${event.message}`);
        break;
      case "text_delta":
        process.stdout.write(event.text);
        break;
      case "tool_start":
        console.log(`   [tool_start] ${event.name}`);
        break;
      case "tool_result":
        console.log(`   [tool_result] ${event.name}: ${event.isError ? "ERROR" : "ok"}`);
        break;
      case "error":
        console.error(`   [error] ${event.message}`);
        break;
      case "complete":
        console.log(`\n   [complete] success=${event.result.success}`);
        if (event.result.usage) {
          console.log(`   [usage] input=${event.result.usage.inputTokens}, output=${event.result.usage.outputTokens}`);
        }
        break;
    }
  }
  console.log(`   Total events: ${eventCount}`);
  console.log("\n=== Test Complete ===");
} catch (error) {
  console.error("\n=== Test Failed ===");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
