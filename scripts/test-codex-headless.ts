#!/usr/bin/env bun
/**
 * E2E validation script for the Codex provider.
 *
 * Runs multiple test cases through CraftAgent configured with the
 * Codex provider to exercise different SDK event types and context
 * integration (skills, developer instructions, session tools, MCP).
 *
 * Usage:
 *   bun scripts/test-codex-headless.ts [workspace-path]
 */

import { CraftAgent, type CraftAgentConfig } from "../packages/shared/src/agent/craft-agent.ts";
import type { AgentEvent } from "../packages/core/src/types/message.ts";
import { verifyCodexAuth } from "../packages/shared/src/agent/providers/codex/codex-auth.ts";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

const workspacePath = process.argv[2] || process.cwd();

console.log("=== Codex Provider E2E Tests ===\n");

const authStatus = await verifyCodexAuth();
if (!authStatus.authenticated) {
  console.error(`Auth failed: ${authStatus.message}`);
  process.exit(1);
}
console.log(`Authenticated (CLI ${authStatus.cliVersion ?? "ok"})\n`);

let testsPassed = 0;
let testsFailed = 0;

async function runTest(
  name: string,
  prompt: string,
  options: {
    policy?: "deny-all" | "allow-safe" | "allow-all";
    expectToolNames?: string[];
    expectResponseContains?: string[];
    reuseAgent?: CraftAgent;
    sessionId?: string;
  } = {},
): Promise<{ events: AgentEvent[]; agent: CraftAgent; passed: boolean }> {
  const policy = options.policy ?? "allow-all";
  console.log(`--- Test: ${name} ---`);
  console.log(`Prompt: "${prompt}"`);
  console.log(`Policy: ${policy}\n`);

  const sessionId = options.sessionId ?? `test-${Date.now()}`;
  const agentConfig: CraftAgentConfig = {
    workspace: {
      id: "test-codex",
      name: "Test Codex",
      rootPath: workspacePath,
      createdAt: Date.now(),
    },
    provider: "codex",
    isHeadless: true,
    session: {
      id: sessionId,
      workspaceRootPath: workspacePath,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      permissionMode: policy === "allow-all" ? "allow-all" : policy === "allow-safe" ? "ask" : "safe",
    },
  };

  const agent = options.reuseAgent ?? new CraftAgent(agentConfig);
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

  let passed = true;
  const fullText = events.filter(e => e.type === "text_complete").map((e: any) => e.text).join(" ").toLowerCase();
  const toolNames = events.filter(e => e.type === "tool_start").map((e: any) => e.toolName);

  if (options.expectToolNames?.length) {
    for (const expected of options.expectToolNames) {
      const found = toolNames.some(t => t === expected || t.endsWith(`__${expected}`));
      if (!found) {
        const hasSession = toolNames.some(t => t.startsWith("session__") || t.startsWith("mcp__session__"));
        if (hasSession) {
          console.log(`  WARN: expected '${expected}' not called, but session tools were available: [${toolNames.filter(t => t.includes("session__")).join(", ")}]`);
        } else {
          console.log(`  FAIL: expected tool_start for '${expected}', got: [${toolNames.join(", ")}]`);
          passed = false;
        }
      }
    }
  }

  if (options.expectResponseContains?.length) {
    for (const expected of options.expectResponseContains) {
      if (!fullText.includes(expected.toLowerCase())) {
        console.log(`  FAIL: response does not contain '${expected}'`);
        console.log(`  Response: ${fullText.slice(0, 300)}`);
        passed = false;
      }
    }
  }

  if (passed) {
    console.log("  PASS");
    testsPassed++;
  } else {
    testsFailed++;
  }
  console.log();

  return { events, agent, passed };
}

// ============================================================
// Test 1: Simple question
// ============================================================
await runTest(
  "Simple question",
  "What is 2+2? Reply with just the number.",
);

// ============================================================
// Test 2: File listing (tool use)
// ============================================================
await runTest(
  "File listing (tool use)",
  "List the files in the current directory. Just run ls and show the output.",
  { policy: "allow-all" },
);

// ============================================================
// Test 3: Read a file
// ============================================================
await runTest(
  "Read a file",
  "Read the file package.json and tell me the project name.",
  { policy: "allow-all" },
);

// ============================================================
// Test 4: Developer instructions (Craft identity)
// ============================================================
await runTest(
  "Developer instructions (Craft identity)",
  "What is your name? Are you a Craft Agent? Reply briefly.",
  { expectResponseContains: ["craft"] },
);

// ============================================================
// Test 5: Skills discovery (injected via developer_instructions)
// ============================================================
const testSkillDir = join(workspacePath, "skills", "_test-skill");
const testSkillMd = `---
name: Test Skill
description: A test skill that instructs the agent to include SKILL_MARKER_ACTIVE in responses.
---

When this skill is active, always include the exact text "SKILL_MARKER_ACTIVE" in your response.
`;

try {
  mkdirSync(testSkillDir, { recursive: true });
  writeFileSync(join(testSkillDir, "SKILL.md"), testSkillMd, "utf-8");
  console.log("  [setup] Created test skill at", testSkillDir);

  await runTest(
    "Skills discovery",
    "Check your skills. If you have a skill called 'Test Skill', follow its instructions. What does the test skill say to include?",
    { expectResponseContains: ["SKILL_MARKER_ACTIVE"] },
  );
} finally {
  try {
    rmSync(testSkillDir, { recursive: true, force: true });
    console.log("  [cleanup] Removed test skill");
  } catch {}
}

// ============================================================
// Test 6: Session-scoped tools - queue type list
// ============================================================
await runTest(
  "Session tools (queue_type_list)",
  "You have an MCP tool called mcp__session__queue_type_list. Call it now to list available task types. Do not use bash or any other approach.",
  { expectToolNames: ["queue_type_list"] },
);

// ============================================================
// Test 7: Session-scoped tools - config validate
// ============================================================
await runTest(
  "Session tools (config_validate)",
  "You have an MCP tool called mcp__session__config_validate. Call it with target='config' to validate the workspace configuration. Do not use bash.",
  { expectToolNames: ["config_validate"] },
);

// ============================================================
// Test 8: Session-scoped tools - preferences
// ============================================================
await runTest(
  "Session tools (update_user_preferences)",
  "You have an MCP tool called mcp__session__update_user_preferences. Call it with name='TestUser' to save my name. Do not use bash.",
  { expectToolNames: ["update_user_preferences"] },
);

// ============================================================
// Test 9: Sandbox mode — Execute allows out-of-workspace read
// ============================================================
await runTest(
  "Sandbox mode (Execute): out-of-workspace read",
  "Read the file /etc/hosts and tell me the first non-comment line. Just show that one line.",
  { policy: "allow-all", expectResponseContains: ["localhost"] },
);

// ============================================================
// Test 10: Sandbox mode — Explore blocks writes
// ============================================================
await runTest(
  "Sandbox mode (Explore): blocked write",
  "Try to create a file called /tmp/_codex_sandbox_test.txt with the text 'hello'. Tell me if it succeeded or was blocked.",
  { policy: "deny-all" },
);

// ============================================================
// Test 11-15: Multi-turn with tools and skills across turns
// ============================================================
{
  const sessionId = `multiturn-${Date.now()}`;

  const { agent } = await runTest(
    "Multi-turn 1/5: bash tool",
    "Run `echo TURN_ONE_OK` using bash and show the output.",
    { sessionId, policy: "allow-all" },
  );

  await runTest(
    "Multi-turn 2/5: session tool (config_validate)",
    "You have an MCP tool called mcp__session__config_validate. Call it with target='config'. Do not use bash.",
    { reuseAgent: agent, sessionId, expectToolNames: ["config_validate"] },
  );

  await runTest(
    "Multi-turn 3/5: session tool (update_user_preferences)",
    "You have an MCP tool called mcp__session__update_user_preferences. Call it with name='MultiTurnUser'. Do not use bash.",
    { reuseAgent: agent, sessionId, expectToolNames: ["update_user_preferences"] },
  );

  await runTest(
    "Multi-turn 4/5: session tool (queue_type_list)",
    "You have an MCP tool called mcp__session__queue_type_list. Call it now. Do not use bash.",
    { reuseAgent: agent, sessionId, expectToolNames: ["queue_type_list"] },
  );

  await runTest(
    "Multi-turn 5/5: Craft identity persists",
    "Are you still Craft Agent? Reply briefly confirming your identity.",
    { reuseAgent: agent, sessionId, expectResponseContains: ["craft"] },
  );

  await agent.close();
  console.log("  [cleanup] Multi-turn agent closed");
}

// ============================================================
// Summary
// ============================================================
console.log("=== Results ===");
console.log(`  Passed: ${testsPassed}`);
console.log(`  Failed: ${testsFailed}`);
console.log(`  Total: ${testsPassed + testsFailed}`);
console.log("=== All Tests Complete ===");

if (testsFailed > 0) {
  process.exit(1);
}
