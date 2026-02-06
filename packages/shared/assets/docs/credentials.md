# Credentials Configuration Guide

This guide explains how to configure credentials for authenticating with external APIs in Craft Agent. Credentials let you use `auth-curl` — a curl wrapper that auto-injects authentication headers based on URL pattern matching.

## How Credentials Work

Credentials are **separate from Sources**. While Sources integrate external services as tools for the agent, Credentials provide lightweight API authentication for direct HTTP requests via `auth-curl`.

**Key principles:**
- **Config files are safe to commit** — they contain URL patterns and auth types, never secrets
- **Secrets are stored in the encrypted credential store** — AES-256-GCM encrypted, separate from configs
- **The LLM never sees secrets** — all credential tools operate through secure UI prompts

**File structure:**
```
~/.craft-agent/workspaces/{ws}/credentials/{slug}.json   ← config (no secrets)
~/.craft-agent/credentials.enc                            ← encrypted secret store
```

## Credential Config Schema

Each credential is a JSON file at `~/.craft-agent/workspaces/{ws}/credentials/{slug}.json`:

```json
{
  "name": "Human-readable name",
  "slug": "url-safe-identifier",
  "urlPatterns": ["https://api.example.com/*"],
  "auth": { "type": "bearer" },

  "icon": "https://example.com/favicon.ico",
  "description": "Optional description",

  "permissions": {
    "explore": {
      "methods": ["GET"],
      "comment": "Read-only in Explore mode"
    }
  },

  "testRequest": {
    "url": "https://api.example.com/me",
    "method": "GET"
  },

  "isAuthenticated": false,
  "lastTestedAt": null
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name (e.g., "Xero", "Stripe") |
| `slug` | string | URL-safe identifier, used as filename (e.g., "xero", "stripe") |
| `urlPatterns` | string[] | URL glob patterns to match (e.g., `["https://api.xero.com/*"]`) |
| `auth` | object | Authentication configuration (see Auth Types below) |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `icon` | string | Icon URL, path, or emoji |
| `description` | string | Human-readable description |
| `permissions` | object | Explore mode restrictions |
| `testRequest` | object | Endpoint to verify credentials work |
| `isAuthenticated` | boolean | Whether credentials are stored (managed by tools) |
| `lastTestedAt` | number \| null | Last test timestamp in ms (managed by tools) |

## Auth Types

### Bearer Token

Injects `Authorization: Bearer {token}` (or custom scheme).

```json
{
  "auth": { "type": "bearer" }
}
```

With custom scheme (e.g., `Authorization: Token {token}`):
```json
{
  "auth": { "type": "bearer", "scheme": "Token" }
}
```

**Setup:** Use `credential_prompt` with `mode: "bearer"`.

### Custom Header

Injects `{headerName}: {token}`.

```json
{
  "auth": { "type": "header", "headerName": "X-API-Key" }
}
```

**Setup:** Use `credential_prompt` with `mode: "header"`.

### Multi-Header

Injects multiple headers (e.g., Datadog's `DD-API-KEY` + `DD-APPLICATION-KEY`).

```json
{
  "auth": {
    "type": "multi-header",
    "headerNames": ["DD-API-KEY", "DD-APPLICATION-KEY"]
  }
}
```

**Setup:** Use `credential_prompt` with `mode: "multi-header"`.

### Query Parameter

Appends `?{paramName}={token}` to the URL.

```json
{
  "auth": { "type": "query", "paramName": "api_key" }
}
```

**Setup:** Use `credential_prompt` with `mode: "query"`.

### Basic Auth

Injects `Authorization: Basic base64(user:pass)`.

```json
{
  "auth": { "type": "basic" }
}
```

**Setup:** Use `credential_prompt` with `mode: "basic"`.

### OAuth 2.0 + PKCE

Full OAuth 2.0 Authorization Code flow with PKCE.

```json
{
  "auth": {
    "type": "oauth2",
    "authorizeUrl": "https://login.xero.com/identity/connect/authorize",
    "tokenUrl": "https://identity.xero.com/connect/token",
    "scopes": ["openid", "accounting.transactions.read"],
    "callbackPort": 9876
  }
}
```

**Setup (3 steps):**
1. `credential_oauth_client` — Collect client_id and client_secret
2. `credential_oauth` — Run the browser-based OAuth flow
3. `credential_test` — Verify the tokens work

## URL Pattern Syntax

Patterns use glob-style matching:

| Pattern | Matches |
|---------|---------|
| `https://api.xero.com/*` | Any path under api.xero.com |
| `https://*.example.com/*` | Any subdomain of example.com |
| `https://api.example.com/v2/*` | Only paths under /v2/ |
| `https://api.example.com/health` | Exact URL match |

**Rules:**
- `*` matches any sequence of characters (including `/`)
- Patterns are matched in order — first match wins
- A credential can have multiple patterns (e.g., API + auth endpoints)
- Matching is case-sensitive

## Explore Mode Permissions

By default, `auth-curl` in Explore mode only allows `GET` requests. Configure `permissions.explore.methods` to allow additional methods:

```json
{
  "permissions": {
    "explore": {
      "methods": ["GET", "POST"],
      "comment": "Allow GET and POST for search endpoints"
    }
  }
}
```

If no permissions block is present, defaults to `["GET"]` only.

## auth-curl CLI

`auth-curl` is a drop-in curl wrapper that auto-injects authentication based on URL pattern matching.

### Usage

```bash
# Automatic credential matching by URL
auth-curl https://api.xero.com/api.xro/2.0/Invoices

# Force a specific credential
auth-curl --credential xero https://api.xero.com/api.xro/2.0/Invoices

# Skip auth injection
auth-curl --no-auth https://api.xero.com/api.xro/2.0/Invoices

# Preview the command (auth values redacted)
auth-curl --dry-run https://api.xero.com/api.xro/2.0/Invoices

# All standard curl flags work
auth-curl -X POST -d '{"key":"value"}' https://api.example.com/data
```

### Flags

| Flag | Description |
|------|-------------|
| `--credential SLUG` | Force a specific credential (skip URL matching) |
| `--no-auth` | Pass through to curl without any auth injection |
| `--dry-run` | Print the curl command with redacted auth values |

### How It Works

1. Finds the active workspace (via `CRAFT_WORKSPACE_ROOT` env var or `~/.craft-agent/config.json`)
2. Loads all credential configs from `credentials/*.json`
3. Matches the request URL against credential `urlPatterns`
4. Loads the secret from the encrypted credential store
5. Builds curl auth flags (`-H`, `--user`, query params) based on auth type
6. Executes curl with the injected auth + all original arguments

If no credential matches, `auth-curl` falls through to plain `curl` (no error).

### Explore Mode Enforcement

When `CRAFT_PERMISSION_MODE=explore` or `CRAFT_PERMISSION_MODE=safe`, auth-curl enforces the credential's `permissions.explore.methods` list. Disallowed methods are rejected with an error.

## Session-Scoped Tools

Five credential tools are available in every session:

### credential_prompt

Prompts the user for static credentials (API keys, tokens, basic auth). The user sees a secure input UI — you never see the secret values.

```
credential_prompt({ slug: "stripe", mode: "bearer" })
credential_prompt({ slug: "datadog", mode: "multi-header" })
credential_prompt({ slug: "jira", mode: "basic" })
```

### credential_oauth_client

Prompts for OAuth client_id and client_secret. Use before `credential_oauth` for OAuth2 services.

```
credential_oauth_client({ slug: "xero", hint: "https://developer.xero.com/app/manage" })
```

### credential_oauth

Initiates OAuth 2.0 + PKCE browser flow. Requires client credentials to be stored first.

```
credential_oauth({ slug: "xero" })
```

### credential_test

Verifies credentials work by making the configured `testRequest`. Updates `isAuthenticated` and `lastTestedAt` in the config.

```
credential_test({ slug: "stripe" })
```

### credential_list

Lists all registered credentials with their authentication status.

```
credential_list({})
```

## Credential Setup Workflow

### Static Credentials (API Keys, Tokens)

1. **Create the config file:**
   ```json
   // credentials/stripe.json
   {
     "name": "Stripe",
     "slug": "stripe",
     "urlPatterns": ["https://api.stripe.com/*"],
     "auth": { "type": "bearer" },
     "testRequest": { "url": "https://api.stripe.com/v1/account" }
   }
   ```

2. **Prompt for the secret:**
   ```
   credential_prompt({ slug: "stripe", mode: "bearer" })
   ```

3. **Test the credentials:**
   ```
   credential_test({ slug: "stripe" })
   ```

### OAuth 2.0 Credentials (e.g., Xero)

1. **Create the config file:**
   ```json
   // credentials/xero.json
   {
     "name": "Xero",
     "slug": "xero",
     "urlPatterns": [
       "https://api.xero.com/*",
       "https://identity.xero.com/*"
     ],
     "auth": {
       "type": "oauth2",
       "authorizeUrl": "https://login.xero.com/identity/connect/authorize",
       "tokenUrl": "https://identity.xero.com/connect/token",
       "scopes": ["openid", "accounting.transactions.read"]
     },
     "permissions": {
       "explore": { "methods": ["GET"] }
     },
     "testRequest": {
       "url": "https://api.xero.com/connections",
       "method": "GET"
     }
   }
   ```

2. **Collect OAuth app credentials:**
   ```
   credential_oauth_client({ slug: "xero", hint: "Create app at developer.xero.com" })
   ```

3. **Run the browser OAuth flow:**
   ```
   credential_oauth({ slug: "xero" })
   ```

4. **Test the tokens:**
   ```
   credential_test({ slug: "xero" })
   ```

## Credentials vs Sources

| Aspect | Credentials | Sources |
|--------|-------------|---------|
| Purpose | Auth for direct HTTP requests | Integrated tools/APIs for the agent |
| Interface | `auth-curl` CLI wrapper | MCP tools, API tools, filesystem tools |
| Config location | `credentials/{slug}.json` | `sources/{slug}/config.json` |
| Auth storage | Same encrypted store (`credentials.enc`) | Same encrypted store |
| Explore mode | Method restrictions via `permissions` | Endpoint/tool restrictions via `permissions.json` |
| Guide file | Not needed (configs are self-documenting) | `guide.md` (recommended) |

**When to use which:**
- **Use a Source** when you want the agent to have tools that call an API (list issues, search documents, etc.)
- **Use a Credential** when you want to make direct HTTP requests to an API via `auth-curl` without building a full Source integration

## Examples

### Datadog (Multi-Header)

```json
{
  "name": "Datadog",
  "slug": "datadog",
  "urlPatterns": ["https://api.datadoghq.com/*"],
  "auth": {
    "type": "multi-header",
    "headerNames": ["DD-API-KEY", "DD-APPLICATION-KEY"]
  },
  "testRequest": {
    "url": "https://api.datadoghq.com/api/v1/validate",
    "method": "GET"
  }
}
```

### GitHub API (Bearer with Token scheme)

```json
{
  "name": "GitHub API",
  "slug": "github-api",
  "urlPatterns": ["https://api.github.com/*"],
  "auth": { "type": "bearer", "scheme": "token" },
  "testRequest": { "url": "https://api.github.com/user" }
}
```

### Google Maps (Query Parameter)

```json
{
  "name": "Google Maps",
  "slug": "google-maps",
  "urlPatterns": ["https://maps.googleapis.com/*"],
  "auth": { "type": "query", "paramName": "key" },
  "testRequest": {
    "url": "https://maps.googleapis.com/maps/api/geocode/json?address=test",
    "method": "GET"
  }
}
```
