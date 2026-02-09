#!/usr/bin/env node
/**
 * Codex MCP Bridge — dependency-free stdio MCP server.
 *
 * Spawned by the Codex CLI as a stdio MCP server. Implements the MCP
 * JSON-RPC protocol (newline-delimited JSON) over stdin/stdout and
 * forwards tool calls to the Electron main process via a Unix domain
 * socket for in-process execution.
 *
 * Environment:
 *   CRAFT_MCP_SOCKET — path to the Unix domain socket
 */

import net from "net";
import { createInterface } from "readline";
import { randomUUID } from "crypto";

const socketPath = process.env.CRAFT_MCP_SOCKET;
if (!socketPath) {
  process.stderr.write("CRAFT_MCP_SOCKET not set\n");
  process.exit(1);
}

let toolDefs = [];
const pendingCalls = new Map();
let ipcBuffer = "";
let toolsReady = false;
let toolsReadyResolve;
const toolsReadyPromise = new Promise((resolve) => { toolsReadyResolve = resolve; });

const ipc = net.createConnection(socketPath, () => {});

ipc.on("error", (err) => {
  process.stderr.write(`IPC error: ${err.message}\n`);
  process.exit(1);
});

ipc.on("data", (chunk) => {
  ipcBuffer += chunk.toString();
  let idx;
  while ((idx = ipcBuffer.indexOf("\n")) !== -1) {
    const line = ipcBuffer.slice(0, idx);
    ipcBuffer = ipcBuffer.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "tools") {
        toolDefs = msg.tools;
        toolsReady = true;
        toolsReadyResolve();
      } else if (msg.type === "result") {
        const resolve = pendingCalls.get(msg.id);
        if (resolve) {
          pendingCalls.delete(msg.id);
          resolve(msg);
        }
      }
    } catch (e) {
      process.stderr.write(`IPC parse error: ${e.message}\n`);
    }
  }
});

function sendStdout(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function callMainProcess(name, args) {
  return new Promise((resolve) => {
    const id = randomUUID();
    pendingCalls.set(id, resolve);
    ipc.write(JSON.stringify({ type: "call", id, name, arguments: args }) + "\n");
  });
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (!msg.jsonrpc || msg.jsonrpc !== "2.0") return;

  if (msg.method === "initialize") {
    sendStdout({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "session", version: "1.0.0" },
      },
    });
    return;
  }

  if (msg.method === "notifications/initialized") {
    return;
  }

  if (msg.method === "tools/list") {
    if (!toolsReady) {
      await toolsReadyPromise;
    }
    sendStdout({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: toolDefs.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    });
    return;
  }

  if (msg.method === "tools/call") {
    if (!toolsReady) {
      await toolsReadyPromise;
    }
    const { name, arguments: args } = msg.params;
    try {
      const result = await callMainProcess(name, args || {});
      sendStdout({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: result.content || [{ type: "text", text: "" }],
          isError: result.isError || false,
        },
      });
    } catch (err) {
      sendStdout({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: `Bridge error: ${err.message}` }],
          isError: true,
        },
      });
    }
    return;
  }

  if (msg.method === "ping") {
    sendStdout({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  if (msg.id !== undefined) {
    sendStdout({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    });
  }
});

rl.on("close", () => {
  ipc.destroy();
  process.exit(0);
});
