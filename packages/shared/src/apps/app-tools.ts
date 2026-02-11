/**
 * App Tools
 *
 * Session-scoped MCP tools for the Custom Apps system.
 * These tools allow agents to create, compile, and preview apps.
 *
 * Tools:
 * - app_create: Scaffold a new app with views and config
 * - app_compile: Compile an app's source (esbuild + Tailwind)
 * - app_preview: Navigate the host UI to show the app
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { debug } from '../utils/debug.ts';

import { validateAppConfig } from './validation.ts';
import { scaffoldApp } from './scaffold.ts';
import { getAppPath, loadAppConfig } from './storage.ts';
import { compileApp } from './compiler.ts';
import type { AppConfig } from './types.ts';

// ============================================================
// Callback Type
// ============================================================

export type OnAppPreviewCallback = (appSlug: string) => void;

// ============================================================
// Tool Factories
// ============================================================

/**
 * Create app_create tool — scaffold a new app
 */
export function createAppCreateTool(sessionId: string, workspaceRootPath: string) {
  return tool(
    'app_create',
    `Create a new custom app in the workspace.

Scaffolds the directory structure with React+Tailwind source files, view components, and config.
The agent should then edit the generated source files to build the app UI, and call app_compile to build it.

**Creates:**
\`\`\`
apps/{slug}/
  config.json
  src/
    App.tsx          # Router with view imports
    views/{view}.tsx # One per view
    index.css        # Tailwind entry
  scripts/           # Data fetching scripts
\`\`\``,
    {
      slug: z.string().regex(/^[a-z0-9-]+$/).describe('URL-safe slug (lowercase, hyphens, numbers)'),
      name: z.string().min(1).describe('Display name for the app'),
      description: z.string().optional().describe('Brief description'),
      icon: z.string().optional().describe('Emoji or URL icon'),
      views: z.array(z.object({
        id: z.string().min(1).describe('Unique view ID'),
        path: z.string().min(1).describe('URL path segment'),
        title: z.string().min(1).describe('Display title'),
        script: z.string().optional().describe('Script name for data fetching'),
      })).min(1).describe('App views (at least one required)'),
      credentials: z.array(z.string()).optional().describe('Credential slugs this app needs'),
      mode: z.enum(['explore', 'execute']).optional().describe("Permission mode for API requests: 'explore' (GET only, default) or 'execute' (full read/write)"),
    },
    async (args) => {
      debug('[app_create] Creating app:', args.slug);
      try {
        // Build the AppConfig
        const config: AppConfig = {
          slug: args.slug,
          name: args.name,
          description: args.description,
          icon: args.icon,
          views: args.views,
          credentials: args.credentials,
          mode: args.mode,
        };

        // Validate
        const validation = validateAppConfig(config);
        if (!validation.valid) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'Invalid app config',
                validationErrors: validation.errors,
              }),
            }],
            isError: true,
          };
        }

        // Scaffold
        const appPath = scaffoldApp(workspaceRootPath, config);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              appPath,
              slug: args.slug,
              message: `App '${args.name}' created at ${appPath}. Edit the source files in src/ and run app_compile to build.`,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}

/**
 * Create app_compile tool — compile an app's source code
 */
export function createAppCompileTool(_sessionId: string, workspaceRootPath: string) {
  return tool(
    'app_compile',
    `Compile a custom app's source code.

Runs esbuild (React/TSX) and Tailwind CSS compilation, then generates index.html.
Returns compile results so the agent can self-correct on errors.`,
    {
      appSlug: z.string().describe('Slug of the app to compile'),
    },
    async (args) => {
      debug('[app_compile] Compiling app:', args.appSlug);
      try {
        // Verify app exists
        const config = loadAppConfig(workspaceRootPath, args.appSlug);
        if (!config) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `App '${args.appSlug}' not found or has invalid config`,
              }),
            }],
            isError: true,
          };
        }

        const appPath = getAppPath(workspaceRootPath, args.appSlug);
        const result = await compileApp(appPath);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: result.success,
              buildTimeMs: result.buildTimeMs,
              errors: result.errors,
            }, null, 2),
          }],
          ...(result.success ? {} : { isError: true }),
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}

/**
 * Create app_preview tool — navigate host UI to show the app
 */
export function createAppPreviewTool(
  _sessionId: string,
  workspaceRootPath: string,
  getCallbacks: (sessionId: string) => { onAppPreview?: OnAppPreviewCallback } | undefined,
  sessionIdForCallback: string,
) {
  return tool(
    'app_preview',
    `Preview a custom app in the host UI.

Navigates the Craft Agent window to display the app. The app must be compiled first.`,
    {
      appSlug: z.string().describe('Slug of the app to preview'),
    },
    async (args) => {
      debug('[app_preview] Previewing app:', args.appSlug);
      try {
        // Verify app exists
        const config = loadAppConfig(workspaceRootPath, args.appSlug);
        if (!config) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `App '${args.appSlug}' not found or has invalid config`,
              }),
            }],
            isError: true,
          };
        }

        // Trigger host navigation via callback
        const callbacks = getCallbacks(sessionIdForCallback);
        if (callbacks?.onAppPreview) {
          callbacks.onAppPreview(args.appSlug);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `Navigating to app '${config.name}'`,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
