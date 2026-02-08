# Testing Conventions

> Quick reference for writing tests in this monorepo. Read this before writing new tests.

## Framework

**Bun's built-in test runner** — no jest, vitest, or external test libraries.

```bash
# Run all tests
bun test

# Run specific file
bun test path/to/file.test.ts

# Run tests matching pattern
bun test --filter "session-reset"
```

## Config

- **`bunfig.toml`** (root) — preloads `test-setup.ts` and `packages/shared/src/network-interceptor.ts`
- **`test-setup.ts`** (root) — DOM polyfills (`DOMMatrix`, `Path2D`, `OffscreenCanvas`) for browser APIs in Node context

## Imports

Always use `bun:test` — nothing else:

```typescript
import { describe, it, expect } from 'bun:test'
```

No external assertion libraries, no mocking libraries, no React Testing Library. Tests focus on **logic, not DOM**.

## File Organization

```
src/
  feature/
    __tests__/
      feature-name.test.ts    # Tests go in __tests__/ subdirectories
    feature-name.ts            # Implementation
```

- Extension: `.test.ts` (not `.spec.ts`)
- Directory: `__tests__/` adjacent to the code being tested
- Naming: `kebab-case.test.ts` matching the feature name

## Test Structure

```typescript
/**
 * Brief description of what's being tested.
 * Note edge cases or bugs being guarded against.
 */

import { describe, it, expect } from 'bun:test'
import { functionUnderTest } from '../module'
import type { SomeType } from '../types'

// ============================================================================
// Test Helpers
// ============================================================================

function createMock(overrides?: Partial<SomeType>): SomeType {
  return {
    id: 'default-id',
    name: 'default',
    ...overrides,
  }
}

// ============================================================================
// Test Suites
// ============================================================================

describe('functionUnderTest', () => {
  describe('specific behavior category', () => {
    it('does X when Y', () => {
      const input = createMock({ name: 'custom' })
      const result = functionUnderTest(input)
      expect(result).toBe(expected)
    })
  })
})
```

## Conventions Observed

1. **Helper factories** at the top — `createMessage()`, `createSession()`, `createTurn()` etc.
2. **`describe` blocks** grouped by behavior category (e.g., "message replacement", "processing state", "edge cases")
3. **`it` descriptions** in "does X when Y" or "returns X for Y" form
4. **No mocking libraries** — inline mock objects and functions
5. **No React Testing Library** — component behavior is tested via logic extraction (pure functions, state machines)
6. **Separator comments** (`// ====`) between helper sections and test suites
7. **JSDoc on the file** explaining what's being tested and why

## Assertion Patterns

```typescript
expect(value).toBe(exact)              // Strict equality (===)
expect(value).toEqual(deepEqual)       // Deep equality
expect(array).toHaveLength(n)
expect(value).toBeUndefined()
expect(value).toBeNull()
expect(value).not.toBe(other)
expect(string).toContain(substring)
expect(() => fn()).toThrow()
expect(obj).toEqual(expect.objectContaining({ key: val }))
```

## What Gets Tested

| Layer | What to test | Example |
|-------|-------------|---------|
| Event processor handlers | Pure `(state, event) → result` functions | `handleSessionResetToMessage` |
| Turn grouping / lifecycle | Message → turn conversion, phase derivation | `groupMessagesByTurn`, `deriveTurnPhase` |
| Shared utilities | Auth, credential storage, source config | `storeBasicAuthCredential` |
| Markdown processing | Link detection, sanitization | `preprocessLinks` |
| Agent logic | Tool matching, SDK fixtures, message channels | `matchTool`, `convertSDKMessage` |

**Not tested via unit tests** (no React Testing Library):
- React component rendering
- DOM interactions
- CSS/styling

## Existing Test Locations

| Path | Count | What |
|------|-------|------|
| `packages/shared/src/agent/__tests__/` | ~9 | Agent logic, tool matching, SDK fixtures |
| `packages/shared/src/sources/__tests__/` | ~8 | Auth schemes, credential manager, source state |
| `packages/shared/src/credentials/__tests__/` | ~4 | Credential storage, proxy, refresh |
| `packages/shared/src/auth/__tests__/` | ~4 | OAuth flow, token handling |
| `packages/mermaid/src/__tests__/` | ~10 | Mermaid rendering and parsing |
| `packages/ui/src/components/chat/__tests__/` | 3 | Turn lifecycle, phase derivation, grouping |
| `packages/ui/src/components/markdown/__tests__/` | 2 | Link detection, sanitization |
| `apps/electron/src/renderer/event-processor/__tests__/` | 1 | Session reset handler |
| `apps/electron/src/renderer/` (misc) | ~5 | Icon cache, mention menu, auth utils |

**Total:** ~64 test files across the monorepo.
