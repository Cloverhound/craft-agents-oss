/**
 * Apps Module
 *
 * Re-exports for the custom apps system.
 */

// Types
export type {
  AppConfig,
  AppViewConfig,
  LoadedApp,
  CompileResult,
  AppScriptResult,
} from './types.ts';

// Validation
export { appConfigSchema, appViewConfigSchema, validateAppConfig } from './validation.ts';

// Storage
export {
  getWorkspaceAppsPath,
  getAppPath,
  getAppConfigPath,
  loadAppConfig,
  loadAllApps,
  deleteApp,
} from './storage.ts';

// Scaffold
export { scaffoldApp } from './scaffold.ts';

// Compiler
export {
  buildEsbuildOptions,
  generateIndexHtml,
  compileApp,
} from './compiler.ts';

// Script Runner
export { runAppScript } from './script-runner.ts';
export type { RunScriptOptions, ScriptResult } from './script-runner.ts';

// App Tools (session-scoped MCP tools)
export {
  createAppCreateTool,
  createAppCompileTool,
  createAppPreviewTool,
} from './app-tools.ts';
export type { OnAppPreviewCallback } from './app-tools.ts';
