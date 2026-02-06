/**
 * Credential Config Types
 *
 * Types for the workspace credential registry — JSON config files that
 * define how to authenticate with external APIs. These configs are safe
 * to commit (no secrets). Secrets are stored separately in credentials.enc.
 *
 * File structure:
 *   ~/.craft-agent/workspaces/{ws}/credentials/{slug}.json
 */

/**
 * Auth type variants for credential injection
 */
export type CredentialAuthConfig =
  | BearerAuthConfig
  | HeaderAuthConfig
  | MultiHeaderAuthConfig
  | QueryAuthConfig
  | BasicAuthConfig
  | OAuth2AuthConfig;

/** Bearer token → Authorization: Bearer {token} (or custom scheme) */
export interface BearerAuthConfig {
  type: 'bearer';
  /** Override the Authorization scheme (default: "Bearer"). e.g. "Token" → "Authorization: Token {token}" */
  scheme?: string;
}

/** Custom header → {headerName}: {token} */
export interface HeaderAuthConfig {
  type: 'header';
  headerName: string;
}

/** Multiple headers → Key1: val1, Key2: val2 */
export interface MultiHeaderAuthConfig {
  type: 'multi-header';
  headerNames: string[];
}

/** Query parameter → ?{paramName}={token} */
export interface QueryAuthConfig {
  type: 'query';
  paramName: string;
}

/** Basic auth → Authorization: Basic base64(user:pass) */
export interface BasicAuthConfig {
  type: 'basic';
}

/** OAuth 2.0 Authorization Code + PKCE */
export interface OAuth2AuthConfig {
  type: 'oauth2';
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Port for local callback server (default: random available port) */
  callbackPort?: number;
}

/**
 * Credential config — stored as JSON in workspace credentials directory.
 * Contains ONLY connection metadata and auth type. No secrets.
 */
export interface CredentialConfig {
  /** Display name */
  name: string;
  /** URL-safe identifier */
  slug: string;
  /** URL patterns to match (glob syntax, e.g. "https://api.xero.com/*") */
  urlPatterns: string[];
  /** How to inject authentication */
  auth: CredentialAuthConfig;
  /** Icon URL, path, or emoji */
  icon?: string;
  /** Human-readable description */
  description?: string;

  /** Explore mode restrictions */
  permissions?: {
    explore?: {
      /** Allowed HTTP methods in Explore mode (default: ["GET"]) */
      methods: string[];
      comment?: string;
    };
  };

  /** Test request to verify credentials work */
  testRequest?: {
    url: string;
    method?: string;
  };

  // Status fields (managed by tools, not edited manually)
  /** Whether credentials are stored and valid */
  isAuthenticated?: boolean;
  /** Last time credentials were tested (Unix timestamp ms) */
  lastTestedAt?: number | null;
}

/**
 * Loaded credential config with workspace context
 */
export interface LoadedCredentialConfig extends CredentialConfig {
  /** Absolute path to the credential config file */
  configPath: string;
  /** Workspace root path */
  workspaceRootPath: string;
  /** Workspace ID (last segment of workspaceRootPath) */
  workspaceId: string;
}
