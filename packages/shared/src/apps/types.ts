/**
 * App Types
 *
 * Types for the Custom Apps system.
 * Apps are user-built React+Tailwind micro-applications that run in
 * sandboxed webviews within Craft Agent.
 *
 * Storage:
 * - App config: {workspaceRootPath}/apps/{slug}/config.json
 * - App source: {workspaceRootPath}/apps/{slug}/src/
 * - App scripts: {workspaceRootPath}/apps/{slug}/scripts/
 * - App build output: {workspaceRootPath}/apps/{slug}/dist/
 */

// ============================================================
// App Configuration
// ============================================================

/**
 * App configuration stored at {workspaceRootPath}/apps/{slug}/config.json
 */
export interface AppConfig {
  /** URL-safe slug (lowercase, hyphens, numbers) — matches folder name */
  slug: string;

  /** Display name */
  name: string;

  /** Brief description */
  description?: string;

  /** Icon: emoji or URL */
  icon?: string;

  /** Semver version string */
  version?: string;

  /** Credential slugs this app needs access to (for script data fetching) */
  credentials?: string[];

  /**
   * Permission mode for this app's API requests.
   *  - 'explore': read-only (GET requests only) — default
   *  - 'execute': full read/write access
   */
  mode?: 'explore' | 'execute';

  /** Sidebar display configuration */
  sidebar?: {
    /** Sort position in sidebar (lower = higher) */
    position?: number;
    /** Badge configuration — shows a count fetched from a script */
    badge?: {
      /** Script name to run for badge count */
      script: string;
      /** Refresh interval in seconds (default: 60) */
      interval?: number;
    };
  };

  /** App views — at least one required */
  views: AppViewConfig[];
}

/**
 * A single view within an app.
 * Each view maps to a route and optionally fetches data via a script.
 */
export interface AppViewConfig {
  /** Unique view ID within this app */
  id: string;

  /** URL path segment for routing */
  path: string;

  /** Display title */
  title: string;

  /** Script name to run for view data (without extension) */
  script?: string;
}

// ============================================================
// Loaded App (runtime representation)
// ============================================================

/**
 * An app loaded from disk with runtime metadata.
 */
export interface LoadedApp {
  /** Parsed config.json */
  config: AppConfig;

  /** Absolute path to the app folder */
  folderPath: string;

  /** Whether dist/index.html exists (app has been compiled) */
  isBuilt: boolean;

  /** Last build error message, if any */
  buildError?: string;

  /** Current runtime permission mode (may differ from config if app switched modes) */
  runtimeMode?: 'explore' | 'execute';
}

// ============================================================
// Compile Result
// ============================================================

/**
 * Result of compiling an app's source code.
 */
export interface CompileResult {
  /** Whether compilation succeeded */
  success: boolean;

  /** Error messages if compilation failed */
  errors?: string[];

  /** Time taken to compile in milliseconds */
  buildTimeMs?: number;
}

// ============================================================
// Script Result
// ============================================================

/**
 * Result of running an app script.
 */
export interface AppScriptResult {
  /** Whether the script ran successfully */
  success: boolean;

  /** Parsed JSON output from the script's stdout */
  result?: unknown;

  /** Captured stderr output */
  stderr?: string;

  /** Process exit code */
  exitCode: number;
}
