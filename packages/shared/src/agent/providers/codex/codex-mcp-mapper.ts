/**
 * Codex MCP Server Mapper
 *
 * Converts Craft's SdkMcpServerConfig entries (used by the Claude provider)
 * to the Codex CLI's RawMcpServerConfig format for config.mcp_servers.
 *
 * Mapping:
 *   HTTP/SSE { type, url, headers } → { url, http_headers, bearer_token }
 *   Stdio    { type, command, args, env } → { command, args, env }
 *   In-process Claude SDK servers → skipped (not serializable)
 *   Craft-internal servers (session, preferences, craft-agents-docs) → skipped
 */

import { debug } from "../../../utils/debug.ts";

export interface CodexRawMcpServerConfig {
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  http_headers?: Record<string, string>;
  bearer_token?: string;
  enabled?: boolean;
}

const SKIP_SERVER_NAMES = new Set(["session", "preferences", "craft-agents-docs"]);

function isPlainConfig(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "type" in value &&
    typeof (value as Record<string, unknown>).type === "string"
  );
}

export function mapSourceMcpServers(
  mcpServers: Record<string, unknown>
): Record<string, CodexRawMcpServerConfig> {
  const result: Record<string, CodexRawMcpServerConfig> = {};

  for (const [name, value] of Object.entries(mcpServers)) {
    if (SKIP_SERVER_NAMES.has(name)) {
      debug(`[CodexMcpMapper] Skipping internal server: ${name}`);
      continue;
    }

    if (!isPlainConfig(value)) {
      debug(`[CodexMcpMapper] Skipping non-serializable server: ${name}`);
      continue;
    }

    const config = value as Record<string, unknown>;
    const type = config.type as string;

    if (type === "http" || type === "sse" || type === "url") {
      const url = config.url as string | undefined;
      if (!url) {
        debug(`[CodexMcpMapper] Skipping HTTP server without URL: ${name}`);
        continue;
      }

      const codexConfig: CodexRawMcpServerConfig = { url };

      const headers = config.headers as Record<string, string> | undefined;
      if (headers) {
        const authHeader = headers["Authorization"] || headers["authorization"];
        if (authHeader && authHeader.startsWith("Bearer ")) {
          codexConfig.bearer_token = authHeader.slice(7);
          const remaining = { ...headers };
          delete remaining["Authorization"];
          delete remaining["authorization"];
          if (Object.keys(remaining).length > 0) {
            codexConfig.http_headers = remaining;
          }
        } else {
          codexConfig.http_headers = headers;
        }
      }

      result[name] = codexConfig;
      debug(`[CodexMcpMapper] Mapped HTTP server: ${name} → ${url}`);
    } else if (type === "stdio") {
      const command = config.command as string | undefined;
      if (!command) {
        debug(`[CodexMcpMapper] Skipping stdio server without command: ${name}`);
        continue;
      }

      const codexConfig: CodexRawMcpServerConfig = { command };
      if (config.args) codexConfig.args = config.args as string[];
      if (config.env) codexConfig.env = config.env as Record<string, string>;

      result[name] = codexConfig;
      debug(`[CodexMcpMapper] Mapped stdio server: ${name} → ${command}`);
    } else {
      debug(`[CodexMcpMapper] Skipping unknown server type: ${name} (${type})`);
    }
  }

  return result;
}
