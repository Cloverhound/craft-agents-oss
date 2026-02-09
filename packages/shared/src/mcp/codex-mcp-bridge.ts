/**
 * Codex MCP Bridge — in-process tool execution via stdio MCP + Unix socket IPC.
 *
 * Mirrors the Claude Agent SDK's `createSdkMcpServer` / `tool` pattern:
 *   - `codexTool(name, description, schema, handler)` defines a tool
 *   - `createCodexMcpServer({ name, version, tools })` creates a bridge
 *
 * Under the hood, a Unix domain socket server runs in the Electron main
 * process. The Codex CLI spawns the bridge entry script as a stdio MCP
 * server, which forwards tool calls over the socket. Tool handlers
 * execute in-process with full access to session state and UI callbacks.
 */

import net from "net";
import { randomUUID } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { debug } from "../utils/debug.ts";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface CodexMcpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export function codexTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<ToolResult>
): CodexMcpToolDef {
  return { name, description, inputSchema, handler };
}

export interface CodexMcpServerHandle {
  config: { command: string; args: string[]; env: Record<string, string> };
  close: () => Promise<void>;
}

export async function createCodexMcpServer(options: {
  name: string;
  version: string;
  tools: CodexMcpToolDef[];
}): Promise<CodexMcpServerHandle> {
  const socketPath = join(tmpdir(), `craft-mcp-${randomUUID()}.sock`);
  const toolMap = new Map<string, CodexMcpToolDef>();
  for (const t of options.tools) {
    toolMap.set(t.name, t);
  }

  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  const server = net.createServer((conn) => {
    debug(`[CodexMcpBridge] Client connected to ${options.name}`);

    const toolDefs = options.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    conn.write(JSON.stringify({ type: "tools", tools: toolDefs }) + "\n");

    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        handleMessage(conn, line).catch((err) => {
          debug(`[CodexMcpBridge] Handler error: ${err.message}`);
        });
      }
    });

    conn.on("error", (err) => {
      debug(`[CodexMcpBridge] Connection error: ${err.message}`);
    });
  });

  async function handleMessage(conn: net.Socket, line: string): Promise<void> {
    let msg: { type: string; id: string; name: string; arguments: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.type !== "call") return;

    const toolDef = toolMap.get(msg.name);
    if (!toolDef) {
      const response = {
        type: "result",
        id: msg.id,
        content: [{ type: "text", text: `Unknown tool: ${msg.name}` }],
        isError: true,
      };
      conn.write(JSON.stringify(response) + "\n");
      return;
    }

    try {
      debug(`[CodexMcpBridge] Calling tool: ${msg.name}`);
      const result = await toolDef.handler(msg.arguments);
      const response = {
        type: "result",
        id: msg.id,
        content: result.content,
        isError: result.isError || false,
      };
      conn.write(JSON.stringify(response) + "\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debug(`[CodexMcpBridge] Tool error (${msg.name}): ${message}`);
      const response = {
        type: "result",
        id: msg.id,
        content: [{ type: "text", text: `Tool error: ${message}` }],
        isError: true,
      };
      conn.write(JSON.stringify(response) + "\n");
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(socketPath, () => {
      debug(`[CodexMcpBridge] Socket server listening: ${socketPath}`);
      resolve();
    });
  });

  const bridgeScriptPath = getBridgeScriptPath();

  const config = {
    command: "node",
    args: [bridgeScriptPath],
    env: {
      CRAFT_MCP_SOCKET: socketPath,
    },
  };

  async function close(): Promise<void> {
    debug(`[CodexMcpBridge] Closing ${options.name}`);
    return new Promise<void>((resolve) => {
      server.close(() => {
        try {
          if (existsSync(socketPath)) {
            unlinkSync(socketPath);
          }
        } catch {
          // ignore cleanup errors
        }
        resolve();
      });
    });
  }

  return { config, close };
}

function getBridgeScriptPath(): string {
  const thisDir = typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

  const candidates = [
    join(thisDir, "codex-mcp-bridge-entry.mjs"),
    join(thisDir, "..", "mcp", "codex-mcp-bridge-entry.mjs"),
    join(thisDir, "..", "packages", "shared", "src", "mcp", "codex-mcp-bridge-entry.mjs"),
  ];

  for (const c of candidates) {
    if (existsSync(c)) {
      debug(`[CodexMcpBridge] Found bridge script: ${c}`);
      return c;
    }
  }

  if (process.env.CRAFT_MCP_BRIDGE_PATH && existsSync(process.env.CRAFT_MCP_BRIDGE_PATH)) {
    return process.env.CRAFT_MCP_BRIDGE_PATH;
  }

  debug(`[CodexMcpBridge] Bridge script not found in: ${candidates.join(", ")}`);
  return candidates[0]!;
}
