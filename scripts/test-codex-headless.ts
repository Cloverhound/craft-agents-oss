#!/usr/bin/env bun
/**
 * E2E validation script for the Codex provider.
 *
 * Runs multiple test cases through CraftAgent configured with the
 * Codex provider to exercise different SDK event types.
 *
 * Usage:
 *   bun scripts/test-codex-headless.ts [workspace-path]
 */

import { CraftAgent, type CraftAgentConfig } from "../packages/shared/src/agent/craft-agent.ts";
import type { AgentEvent } from "../packages/core/src/types/message.ts";
import { verifyCodexAuth } from "../packages/shared/src/agent/providers/codex/codex-auth.ts";

const workspacePath = process.argv[2] || process.cwd();

console.log("=== Codex Provider E2E Tests ===\n");

const authStatus = await verifyCodexAuth();
if (!authStatus.authenticated) {
  console.error(`Auth failed: ${authStatus.message}`);
  process.exit(1);
}
console.log(`Authenticated (CLI ${authStatus.cliVersion ?? "ok"})\n`);

async function runTest(name: string, prompt: string, policy: "deny-all" | "allow-safe" | "allow-all" = "allow-all") {
  console.log(`--- Test: ${name} ---`);
  console.log(`Prompt: "${prompt}"`);
  console.log(`Policy: ${policy}\n`);

  const agentConfig: CraftAgentConfig = {
    workspace: {
      id: "test-codex",
      name: "Test Codex",
      rootPath: workspacePath,
    },
    provider: "codex",
    isHeadless: true,
    session: {
      id: `test-${Date.now()}`,
      workspaceRootPath: workspacePath,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      permissionMode: policy === "allow-all" ? "allow-all" : policy === "allow-safe" ? "ask" : "safe",
    },
  };

  const agent = new CraftAgent(agentConfig);
  const events: AgentEvent[] = [];
  const start = Date.now();

  try {
    for await (const event of agent.chat(prompt)) {
      events.push(event);

      switch (event.type) {
        case "status":
          console.log(`  [status] ${event.message}`);
          break;
        case "info":
          console.log(`  [info] ${event.message}`);
          break;
        case "text_delta":
          process.stdout.write(event.text);
          break;
        case "text_complete":
          console.log(`\n  [text_complete] "${event.text.slice(0, 200)}${event.text.length > 200 ? "..." : ""}"`);
          break;
        case "tool_start":
          console.log(`  [tool_start] ${event.toolName} (${event.toolUseId})`);
          if (event.input) {
            const inputStr = JSON.stringify(event.input);
            console.log(`    input: ${inputStr.slice(0, 200)}${inputStr.length > 200 ? "..." : ""}`);
          }
          break;
        case "tool_result":
          const preview = event.result.slice(0, 150);
          console.log(`  [tool_result] ${event.toolName ?? event.toolUseId}: ${event.isError ? "ERROR" : "ok"}`);
          console.log(`    result: ${preview}${event.result.length > 150 ? "..." : ""}`);
          break;
        case "error":
          console.log(`  [error] ${event.message}`);
          break;
        case "typed_error":
          console.log(`  [typed_error] ${event.error.code}: ${event.error.message}`);
          break;
        case "complete":
          console.log(`  [complete] usage: ${JSON.stringify(event.usage ?? {})}`);
          break;
        case "permission_request":
          console.log(`  [permission] ${event.toolName}: ${event.command}`);
          break;
        default:
          console.log(`  [${(event as any).type}] ${JSON.stringify(event).slice(0, 100)}`);
      }
    }
  } catch (err) {
    console.error(`  EXCEPTION: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await agent.close();
  }

  const elapsed = Date.now() - start;
  const eventTypes = events.map(e => e.type);
  const typeCounts: Record<string, number> = {};
  for (const t of eventTypes) {
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }

  console.log(`\n  Events (${events.length} total, ${elapsed}ms):`);
  for (const [type, count] of Object.entries(typeCounts).sort()) {
    console.log(`    ${type}: ${count}`);
  }
  console.log();
}

// Test 1: Simple question (should produce agent_message + reasoning)
await runTest(
  "Simple question",
  "What is 2+2? Reply with just the number."
);

// Test 2: File listing (should trigger command_execution / tool use)
await runTest(
  "File listing (tool use)",
  "List the files in the current directory. Just run ls and show the output.",
  "allow-all"
);

// Test 3: Read a file (should trigger file read)
await runTest(
  "Read a file",
  "Read the file package.json and tell me the project name.",
  "allow-all"
);

console.log("=== All Tests Complete ===");
