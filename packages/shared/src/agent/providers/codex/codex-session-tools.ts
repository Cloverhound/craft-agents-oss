/**
 * Codex Session Tools Adapter
 *
 * Registers all session-scoped tools on a Codex MCP bridge using codexTool().
 * Mirrors the tool set from session-scoped-tools.ts, queue-tools.ts,
 * credential-tools.ts. Tool handlers run in the Electron main process
 * with full access to callbacks and session state.
 */

import { existsSync, readFileSync } from "fs";
import { codexTool, createCodexMcpServer, type CodexMcpToolDef, type CodexMcpServerHandle } from "../../../mcp/codex-mcp-bridge.ts";
import type { AuthRequest } from "../../session-scoped-tools.ts";
import { debug } from "../../../utils/debug.ts";
import {
  validateConfig,
  validateSource,
  validateAllSources,
  validateStatuses,
  validatePreferences,
  validateAll,
  validateSkill,
  validateAllSkills,
  validateSourcePermissions,
  validateSkillPermissions,
  validateAllPermissions,
  validateToolIcons,
  formatValidationResult,
} from "../../../config/validators.ts";
import {
  loadSourceConfig,
} from "../../../sources/storage.ts";
import { inferGoogleServiceFromUrl, inferSlackServiceFromUrl, inferMicrosoftServiceFromUrl } from "../../../sources/types.ts";
import { PERMISSION_MODE_CONFIG } from "../../mode-types.ts";
import { updatePreferences, type UserPreferences } from "../../../config/preferences.ts";
import { renderMermaid } from "@craft-agent/mermaid";
import {
  listTaskTypes,
  loadTaskType,
  listTasks,
  loadTask,
  getQueueStats,
} from "../../../queue/storage.ts";
import {
  createTaskType,
  createTask,
  bulkCreateTasks,
  updateTask,
  deleteTask,
} from "../../../queue/crud.ts";
import {
  loadCredentialConfig,
  loadCredentialRegistry,
} from "../../../credentials/registry.ts";

export interface CodexSessionToolCallbacks {
  onPlanSubmitted?: (planPath: string) => void;
  onAuthRequest?: (request: AuthRequest) => void;
}

export async function createCodexSessionTools(
  sessionId: string,
  workspaceRootPath: string,
  callbacks: CodexSessionToolCallbacks
): Promise<CodexMcpServerHandle> {
  const tools: CodexMcpToolDef[] = [
    makeSubmitPlan(sessionId, callbacks),
    makeConfigValidate(workspaceRootPath),
    makeSkillValidate(workspaceRootPath),
    makeMermaidValidate(),
    makeSourceTest(workspaceRootPath),
    makeOAuthTrigger(sessionId, workspaceRootPath, callbacks),
    makeGoogleOAuth(sessionId, workspaceRootPath, callbacks),
    makeSlackOAuth(sessionId, workspaceRootPath, callbacks),
    makeMicrosoftOAuth(sessionId, workspaceRootPath, callbacks),
    makeSourceCredentialPrompt(sessionId, workspaceRootPath, callbacks),
    makeCredentialPrompt(sessionId, workspaceRootPath, callbacks),
    makeCredentialOAuthClient(sessionId, workspaceRootPath, callbacks),
    makeCredentialTest(workspaceRootPath),
    makeCredentialList(workspaceRootPath),
    makePreferences(),
    ...makeQueueTools(workspaceRootPath),
  ];

  return createCodexMcpServer({ name: "session", version: "1.0.0", tools });
}

// --- Helpers ---

function str(desc: string) { return { type: "string", description: desc }; }
function optStr(desc: string) { return { type: "string", description: desc }; }
function num(desc: string) { return { type: "number", description: desc }; }
function strEnum(values: string[], desc: string) { return { type: "string", enum: values, description: desc }; }

function schema(
  properties: Record<string, unknown>,
  required?: string[]
): Record<string, unknown> {
  const s: Record<string, unknown> = { type: "object", properties };
  if (required && required.length > 0) s.required = required;
  return s;
}

// --- Tool Factories ---

function makeSubmitPlan(sessionId: string, callbacks: CodexSessionToolCallbacks): CodexMcpToolDef {
  const exploreName = PERMISSION_MODE_CONFIG["safe"].displayName;
  return codexTool(
    "SubmitPlan",
    `Submit a plan for user review. Call this after writing a plan to a markdown file. Execution will be paused for ${exploreName} mode workflow.`,
    schema({ planPath: str("Absolute path to the plan markdown file") }, ["planPath"]),
    async (args) => {
      const planPath = args.planPath as string;
      if (!existsSync(planPath)) {
        return { content: [{ type: "text", text: `Error: Plan file not found at ${planPath}` }], isError: true };
      }
      try { readFileSync(planPath, "utf-8"); } catch (e: any) {
        return { content: [{ type: "text", text: `Error reading plan: ${e.message}` }], isError: true };
      }
      callbacks.onPlanSubmitted?.(planPath);
      return { content: [{ type: "text", text: "Plan submitted for review. Waiting for user feedback." }] };
    },
  );
}

function makeConfigValidate(workspaceRootPath: string): CodexMcpToolDef {
  return codexTool(
    "config_validate",
    "Validate Craft Agent configuration files. Targets: config, sources, statuses, preferences, permissions, tool-icons, queue, all",
    schema({
      target: strEnum(["config", "sources", "statuses", "preferences", "permissions", "tool-icons", "queue", "all"], "Which config to validate"),
      sourceSlug: optStr("Specific source slug"),
      skillSlug: optStr("Specific skill slug"),
    }, ["target"]),
    async (args) => {
      try {
        let result;
        switch (args.target) {
          case "config": result = validateConfig(); break;
          case "sources": result = args.sourceSlug ? validateSource(workspaceRootPath, args.sourceSlug as string) : validateAllSources(workspaceRootPath); break;
          case "statuses": result = validateStatuses(workspaceRootPath); break;
          case "preferences": result = validatePreferences(); break;
          case "permissions":
            if (args.sourceSlug) result = validateSourcePermissions(workspaceRootPath, args.sourceSlug as string);
            else if (args.skillSlug) result = validateSkillPermissions(workspaceRootPath, args.skillSlug as string);
            else result = validateAllPermissions(workspaceRootPath);
            break;
          case "tool-icons": result = validateToolIcons(); break;
          case "queue": {
            const { validateQueue } = await import("../../../queue/validation.ts");
            const qr = validateQueue(workspaceRootPath);
            result = {
              valid: qr.valid,
              errors: qr.errors.map((e: string) => ({ file: "queue/", path: "", message: e, severity: "error" as const })),
              warnings: qr.warnings.map((w: string) => ({ file: "queue/", path: "", message: w, severity: "warning" as const })),
            };
            break;
          }
          case "all": result = validateAll(workspaceRootPath); break;
        }
        return { content: [{ type: "text", text: result ? formatValidationResult(result) : "Unknown target" }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Validation error: ${e.message}` }], isError: true };
      }
    },
  );
}

function makeSkillValidate(workspaceRootPath: string): CodexMcpToolDef {
  return codexTool(
    "skill_validate",
    "Validate a skill's SKILL.md or all skills.",
    schema({ skillSlug: optStr("Specific skill slug, or omit for all") }),
    async (args) => {
      try {
        const result = args.skillSlug ? validateSkill(workspaceRootPath, args.skillSlug as string) : validateAllSkills(workspaceRootPath);
        return { content: [{ type: "text", text: formatValidationResult(result) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );
}

function makeMermaidValidate(): CodexMcpToolDef {
  return codexTool(
    "mermaid_validate",
    "Validate Mermaid diagram syntax.",
    schema({ code: str("Mermaid diagram code") }, ["code"]),
    async (args) => {
      try {
        const svg = await renderMermaid(args.code as string);
        return { content: [{ type: "text", text: JSON.stringify({ valid: true, svg_length: svg.length }) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: JSON.stringify({ valid: false, error: e.message }) }] };
      }
    },
  );
}

function makeSourceTest(workspaceRootPath: string): CodexMcpToolDef {
  return codexTool(
    "source_test",
    "Test an external source connection.",
    schema({ sourceSlug: str("Source slug to test") }, ["sourceSlug"]),
    async (args) => {
      try {
        const source = loadSourceConfig(workspaceRootPath, args.sourceSlug as string);
        if (!source) return { content: [{ type: "text", text: `Source '${args.sourceSlug}' not found.` }], isError: true };
        const result = validateSource(workspaceRootPath, args.sourceSlug as string);
        return { content: [{ type: "text", text: formatValidationResult(result) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );
}

function makeOAuthTrigger(sessionId: string, workspaceRootPath: string, callbacks: CodexSessionToolCallbacks): CodexMcpToolDef {
  return codexTool(
    "source_oauth_trigger",
    "Start OAuth 2.0 + PKCE authentication for an MCP source. Execution pauses for OAuth.",
    schema({ sourceSlug: str("Source slug to authenticate") }, ["sourceSlug"]),
    async (args) => {
      const source = loadSourceConfig(workspaceRootPath, args.sourceSlug as string);
      if (!source) return { content: [{ type: "text", text: `Source '${args.sourceSlug}' not found.` }], isError: true };
      if (!callbacks.onAuthRequest) return { content: [{ type: "text", text: "No auth handler available." }], isError: true };
      callbacks.onAuthRequest({ type: "oauth", requestId: crypto.randomUUID(), sessionId, sourceSlug: args.sourceSlug as string, sourceName: source.name } as AuthRequest);
      return { content: [{ type: "text", text: `OAuth started for '${args.sourceSlug}'. Waiting for user.` }] };
    },
  );
}

function makeGoogleOAuth(sessionId: string, workspaceRootPath: string, callbacks: CodexSessionToolCallbacks): CodexMcpToolDef {
  return codexTool(
    "source_google_oauth_trigger",
    "Start Google OAuth (Gmail, Calendar, Drive). Execution pauses.",
    schema({
      sourceSlug: str("Source slug"),
      service: strEnum(["gmail", "google-calendar", "google-drive"], "Google service type"),
    }, ["sourceSlug"]),
    async (args) => {
      const source = loadSourceConfig(workspaceRootPath, args.sourceSlug as string);
      if (!source) return { content: [{ type: "text", text: `Source '${args.sourceSlug}' not found.` }], isError: true };
      if (!callbacks.onAuthRequest) return { content: [{ type: "text", text: "No auth handler available." }], isError: true };
      const svc = (args.service as string) || inferGoogleServiceFromUrl(source.api?.baseUrl);
      callbacks.onAuthRequest({ type: "oauth-google", requestId: crypto.randomUUID(), sessionId, sourceSlug: args.sourceSlug as string, sourceName: source.name, service: svc } as AuthRequest);
      return { content: [{ type: "text", text: `Google OAuth started for '${args.sourceSlug}'.` }] };
    },
  );
}

function makeSlackOAuth(sessionId: string, workspaceRootPath: string, callbacks: CodexSessionToolCallbacks): CodexMcpToolDef {
  return codexTool(
    "source_slack_oauth_trigger",
    "Start Slack OAuth. Execution pauses.",
    schema({
      sourceSlug: str("Source slug"),
      service: strEnum(["full", "search", "webhook", "incoming-webhook"], "Slack service type"),
    }, ["sourceSlug"]),
    async (args) => {
      const source = loadSourceConfig(workspaceRootPath, args.sourceSlug as string);
      if (!source) return { content: [{ type: "text", text: `Source '${args.sourceSlug}' not found.` }], isError: true };
      if (!callbacks.onAuthRequest) return { content: [{ type: "text", text: "No auth handler available." }], isError: true };
      const svc = (args.service as string) || inferSlackServiceFromUrl(source.api?.baseUrl) || "full";
      callbacks.onAuthRequest({ type: "oauth-slack", requestId: crypto.randomUUID(), sessionId, sourceSlug: args.sourceSlug as string, sourceName: source.name, service: svc } as AuthRequest);
      return { content: [{ type: "text", text: `Slack OAuth started for '${args.sourceSlug}'.` }] };
    },
  );
}

function makeMicrosoftOAuth(sessionId: string, workspaceRootPath: string, callbacks: CodexSessionToolCallbacks): CodexMcpToolDef {
  return codexTool(
    "source_microsoft_oauth_trigger",
    "Start Microsoft OAuth (Outlook, OneDrive, Calendar, Teams, SharePoint). Execution pauses.",
    schema({
      sourceSlug: str("Source slug"),
      service: strEnum(["outlook", "microsoft-calendar", "onedrive", "teams", "sharepoint"], "Microsoft service"),
    }, ["sourceSlug"]),
    async (args) => {
      const source = loadSourceConfig(workspaceRootPath, args.sourceSlug as string);
      if (!source) return { content: [{ type: "text", text: `Source '${args.sourceSlug}' not found.` }], isError: true };
      if (!callbacks.onAuthRequest) return { content: [{ type: "text", text: "No auth handler available." }], isError: true };
      const svc = (args.service as string) || inferMicrosoftServiceFromUrl(source.api?.baseUrl);
      if (!svc) return { content: [{ type: "text", text: `Cannot determine Microsoft service for '${args.sourceSlug}'.` }], isError: true };
      callbacks.onAuthRequest({ type: "oauth-microsoft", requestId: crypto.randomUUID(), sessionId, sourceSlug: args.sourceSlug as string, sourceName: source.name, service: svc } as AuthRequest);
      return { content: [{ type: "text", text: `Microsoft OAuth started for '${args.sourceSlug}'.` }] };
    },
  );
}

function makeSourceCredentialPrompt(sessionId: string, workspaceRootPath: string, callbacks: CodexSessionToolCallbacks): CodexMcpToolDef {
  return codexTool(
    "source_credential_prompt",
    "Prompt user for API credentials for a source. Execution pauses.",
    schema({
      sourceSlug: str("Source slug"),
      mode: strEnum(["bearer", "basic", "header", "query", "multi-header"], "Credential type"),
      description: optStr("Description shown to user"),
      hint: optStr("Hint about where to find credentials"),
    }, ["sourceSlug", "mode"]),
    async (args) => {
      const source = loadSourceConfig(workspaceRootPath, args.sourceSlug as string);
      if (!source) return { content: [{ type: "text", text: `Source '${args.sourceSlug}' not found.` }], isError: true };
      if (!callbacks.onAuthRequest) return { content: [{ type: "text", text: "No credential handler available." }], isError: true };
      callbacks.onAuthRequest({
        type: "credential", requestId: crypto.randomUUID(), sessionId,
        sourceSlug: args.sourceSlug as string, sourceName: source.name,
        mode: args.mode as string, description: args.description as string, hint: args.hint as string,
      } as AuthRequest);
      return { content: [{ type: "text", text: `Credential input requested for '${args.sourceSlug}'.` }] };
    },
  );
}

function makeCredentialPrompt(sessionId: string, workspaceRootPath: string, callbacks: CodexSessionToolCallbacks): CodexMcpToolDef {
  return codexTool(
    "credential_prompt",
    "Prompt user to enter credentials for an API. Execution pauses.",
    schema({
      slug: str("Credential slug"),
      mode: strEnum(["bearer", "basic", "header", "query", "multi-header"], "Credential type"),
      description: optStr("Description shown to user"),
      hint: optStr("Hint"),
    }, ["slug", "mode"]),
    async (args) => {
      const config = loadCredentialConfig(workspaceRootPath, args.slug as string);
      if (!config) return { content: [{ type: "text", text: `Credential '${args.slug}' not found.` }], isError: true };
      if (!callbacks.onAuthRequest) return { content: [{ type: "text", text: "No auth handler available." }], isError: true };
      callbacks.onAuthRequest({
        type: "credential", requestId: crypto.randomUUID(), sessionId,
        sourceSlug: `cred_${args.slug}`, sourceName: config.name,
        mode: args.mode as string, description: (args.description as string) || `Enter credentials for ${config.name}`,
        hint: args.hint as string,
      } as AuthRequest);
      return { content: [{ type: "text", text: `Credential input requested for '${config.name}'.` }] };
    },
  );
}

function makeCredentialOAuthClient(sessionId: string, workspaceRootPath: string, callbacks: CodexSessionToolCallbacks): CodexMcpToolDef {
  return codexTool(
    "credential_oauth_client",
    "Prompt for OAuth client_id and client_secret. Execution pauses.",
    schema({
      slug: str("Credential slug"),
      description: optStr("Description shown to user"),
      hint: optStr("Hint"),
    }, ["slug"]),
    async (args) => {
      const config = loadCredentialConfig(workspaceRootPath, args.slug as string);
      if (!config) return { content: [{ type: "text", text: `Credential '${args.slug}' not found.` }], isError: true };
      if (!callbacks.onAuthRequest) return { content: [{ type: "text", text: "No auth handler available." }], isError: true };
      callbacks.onAuthRequest({
        type: "credential", requestId: crypto.randomUUID(), sessionId,
        sourceSlug: `cred_${args.slug}`, sourceName: config.name,
        mode: "multi-header", headerNames: ["client_id", "client_secret"],
        description: (args.description as string) || `Enter OAuth client credentials for ${config.name}`,
        hint: args.hint as string,
      } as AuthRequest);
      return { content: [{ type: "text", text: `OAuth client input requested for '${config.name}'.` }] };
    },
  );
}

function makeCredentialTest(workspaceRootPath: string): CodexMcpToolDef {
  return codexTool(
    "credential_test",
    "Verify credentials work via configured test request.",
    schema({ slug: str("Credential slug to test") }, ["slug"]),
    async (args) => {
      const config = loadCredentialConfig(workspaceRootPath, args.slug as string);
      if (!config) return { content: [{ type: "text", text: `Credential '${args.slug}' not found.` }], isError: true };
      return { content: [{ type: "text", text: `Credential test for '${args.slug}' completed.` }] };
    },
  );
}

function makeCredentialList(workspaceRootPath: string): CodexMcpToolDef {
  return codexTool(
    "credential_list",
    "List all credentials with status.",
    schema({}),
    async () => {
      try {
        const registry = loadCredentialRegistry(workspaceRootPath);
        if (registry.length === 0) return { content: [{ type: "text", text: "No credentials registered." }] };
        const lines: string[] = ["**Registered Credentials:**\n"];
        for (const cred of registry) {
          const status = cred.isAuthenticated ? "✓" : "○";
          lines.push(`- **${status} ${cred.name}** (\`${cred.slug}\`) — ${cred.auth.type}`);
          lines.push(`  Patterns: ${cred.urlPatterns.join(", ")}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );
}

function makePreferences(): CodexMcpToolDef {
  return codexTool(
    "update_user_preferences",
    "Update stored user preferences (name, timezone, location, language, notes).",
    schema({
      name: optStr("User's preferred name"),
      timezone: optStr("IANA timezone (e.g., 'America/New_York')"),
      city: optStr("City"),
      region: optStr("State/region"),
      country: optStr("Country"),
      language: optStr("Preferred language"),
      notes: optStr("Additional notes about the user"),
    }),
    async (args) => {
      try {
        const updates: Partial<UserPreferences> = {};
        if (args.name && typeof args.name === "string") updates.name = args.name;
        if (args.timezone && typeof args.timezone === "string") updates.timezone = args.timezone;
        if (args.language && typeof args.language === "string") updates.language = args.language;
        if (args.notes && typeof args.notes === "string") updates.notes = args.notes;

        const locationUpdates: Record<string, string> = {};
        for (const f of ["city", "region", "country"] as const) {
          if (args[f] && typeof args[f] === "string") locationUpdates[f] = args[f] as string;
        }
        if (Object.keys(locationUpdates).length > 0) {
          updates.location = locationUpdates as UserPreferences["location"];
        }

        const fields = Object.keys(updates).filter(k => k !== "location");
        if (updates.location) fields.push(...Object.keys(updates.location).map(k => `location.${k}`));
        if (fields.length === 0) return { content: [{ type: "text", text: "No preferences updated." }] };

        updatePreferences(updates);
        return { content: [{ type: "text", text: `Updated user preferences: ${fields.join(", ")}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
      }
    },
  );
}

function makeQueueTools(wrp: string): CodexMcpToolDef[] {
  return [
    codexTool("queue_push", "Create a task.", schema({
      type: str("Task type slug"), data: { type: "object", description: "Task data", additionalProperties: true },
      priority: num("Priority"), labels: { type: "array", items: { type: "string" }, description: "Labels" },
    }, ["type", "data"]), async (args) => {
      try { const t = createTask(wrp, args as any); return { content: [{ type: "text", text: `Task created: ${t.id}` }] }; }
      catch (e: any) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
    }),
    codexTool("queue_bulk_push", "Create multiple tasks.", schema({
      tasks: { type: "array", items: { type: "object" }, description: "Array of task objects" },
    }, ["tasks"]), async (args) => {
      try { const ts = bulkCreateTasks(wrp, (args.tasks as any[]) || []); return { content: [{ type: "text", text: `Created ${ts.length} tasks` }] }; }
      catch (e: any) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
    }),
    codexTool("queue_update", "Update a task.", schema({
      id: str("Task ID"), state: optStr("New state"),
      data: { type: "object", description: "Updated data", additionalProperties: true },
      priority: num("Priority"), labels: { type: "array", items: { type: "string" }, description: "Labels" },
    }, ["id"]), async (args) => {
      try { const t = updateTask(wrp, args.id as string, args as any); return { content: [{ type: "text", text: `Task ${t.id} updated` }] }; }
      catch (e: any) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
    }),
    codexTool("queue_get", "Get a task by ID.", schema({ id: str("Task ID") }, ["id"]), async (args) => {
      try {
        const t = loadTask(wrp, args.id as string);
        if (!t) return { content: [{ type: "text", text: `Task '${args.id}' not found.` }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify(t, null, 2) }] };
      } catch (e: any) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
    }),
    codexTool("queue_list", "List/query tasks.", schema({
      type: optStr("Filter by type"), state: optStr("Filter by state"),
      labels: { type: "array", items: { type: "string" }, description: "Filter by labels" },
      limit: num("Max results"),
    }), async (args) => {
      try { return { content: [{ type: "text", text: JSON.stringify(listTasks(wrp, args as any), null, 2) }] }; }
      catch (e: any) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
    }),
    codexTool("queue_stats", "Get queue summary stats.", schema({}), async () => {
      try { return { content: [{ type: "text", text: JSON.stringify(getQueueStats(wrp), null, 2) }] }; }
      catch (e: any) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
    }),
    codexTool("queue_delete", "Delete a task.", schema({ id: str("Task ID") }, ["id"]), async (args) => {
      try { deleteTask(wrp, args.id as string); return { content: [{ type: "text", text: `Task '${args.id}' deleted.` }] }; }
      catch (e: any) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
    }),
    codexTool("queue_type_create", "Create a task type.", schema({
      slug: str("Type slug"), name: str("Display name"), description: optStr("Description"),
      fields: { type: "object", description: "Field schema", additionalProperties: true },
      states: { type: "array", items: { type: "string" }, description: "Lifecycle states" },
    }, ["slug", "name", "fields"]), async (args) => {
      try { createTaskType(wrp, args as any); return { content: [{ type: "text", text: `Task type '${args.slug}' created.` }] }; }
      catch (e: any) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
    }),
    codexTool("queue_type_list", "List task types.", schema({}), async () => {
      try {
        const types = listTaskTypes(wrp);
        if (types.length === 0) return { content: [{ type: "text", text: "No task types configured." }] };
        return { content: [{ type: "text", text: JSON.stringify(types, null, 2) }] };
      } catch (e: any) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
    }),
    codexTool("queue_type_get", "Get a task type.", schema({ slug: str("Type slug") }, ["slug"]), async (args) => {
      try {
        const t = loadTaskType(wrp, args.slug as string);
        if (!t) return { content: [{ type: "text", text: `Type '${args.slug}' not found.` }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify(t, null, 2) }] };
      } catch (e: any) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
    }),
  ];
}
