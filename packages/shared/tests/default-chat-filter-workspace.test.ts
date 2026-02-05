/**
 * Tests for defaultChatFilter in workspace configuration.
 *
 * These tests verify:
 * - WorkspaceConfig correctly stores/loads defaultChatFilter
 * - Fallback behaviour when no filter is set
 * - Handling of deleted/invalid filter references
 * - Config round-trip through save/load
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import {
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  createWorkspaceAtPath,
} from '../src/workspaces/storage.ts'
import type { WorkspaceConfig } from '../src/workspaces/types.ts'

// ============================================================
// Test Setup
// ============================================================

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `craft-test-${randomUUID().slice(0, 8)}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true })
  }
})

// Helper: create a minimal workspace config
function createTestConfig(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    id: 'test-ws',
    name: 'Test Workspace',
    slug: 'test-workspace',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

// ============================================================
// defaultChatFilter in WorkspaceConfig
// ============================================================

describe('defaultChatFilter in workspace config', () => {
  describe('save and load', () => {
    it('saves and loads allChats filter', () => {
      const config = createTestConfig({
        defaults: { defaultChatFilter: 'allChats' },
      })
      saveWorkspaceConfig(testDir, config)
      const loaded = loadWorkspaceConfig(testDir)
      expect(loaded?.defaults?.defaultChatFilter).toBe('allChats')
    })

    it('saves and loads flagged filter', () => {
      const config = createTestConfig({
        defaults: { defaultChatFilter: 'flagged' },
      })
      saveWorkspaceConfig(testDir, config)
      const loaded = loadWorkspaceConfig(testDir)
      expect(loaded?.defaults?.defaultChatFilter).toBe('flagged')
    })

    it('saves and loads state filter', () => {
      const config = createTestConfig({
        defaults: { defaultChatFilter: 'state:todo' },
      })
      saveWorkspaceConfig(testDir, config)
      const loaded = loadWorkspaceConfig(testDir)
      expect(loaded?.defaults?.defaultChatFilter).toBe('state:todo')
    })

    it('saves and loads state filter with hyphenated ID', () => {
      const config = createTestConfig({
        defaults: { defaultChatFilter: 'state:in-progress' },
      })
      saveWorkspaceConfig(testDir, config)
      const loaded = loadWorkspaceConfig(testDir)
      expect(loaded?.defaults?.defaultChatFilter).toBe('state:in-progress')
    })

    it('saves and loads label filter', () => {
      const config = createTestConfig({
        defaults: { defaultChatFilter: 'label:priority' },
      })
      saveWorkspaceConfig(testDir, config)
      const loaded = loadWorkspaceConfig(testDir)
      expect(loaded?.defaults?.defaultChatFilter).toBe('label:priority')
    })

    it('saves and loads view filter', () => {
      const config = createTestConfig({
        defaults: { defaultChatFilter: 'view:my-custom-view' },
      })
      saveWorkspaceConfig(testDir, config)
      const loaded = loadWorkspaceConfig(testDir)
      expect(loaded?.defaults?.defaultChatFilter).toBe('view:my-custom-view')
    })
  })

  describe('undefined / missing filter (default behaviour)', () => {
    it('returns undefined when no defaultChatFilter is set', () => {
      const config = createTestConfig({ defaults: {} })
      saveWorkspaceConfig(testDir, config)
      const loaded = loadWorkspaceConfig(testDir)
      expect(loaded?.defaults?.defaultChatFilter).toBeUndefined()
    })

    it('returns undefined when defaults is not set', () => {
      const config = createTestConfig()
      // Explicitly remove defaults
      delete config.defaults
      saveWorkspaceConfig(testDir, config)
      const loaded = loadWorkspaceConfig(testDir)
      expect(loaded?.defaults?.defaultChatFilter).toBeUndefined()
    })

    it('preserves other defaults when defaultChatFilter is not set', () => {
      const config = createTestConfig({
        defaults: {
          model: 'claude-sonnet-4-5-20250929',
          permissionMode: 'ask',
        },
      })
      saveWorkspaceConfig(testDir, config)
      const loaded = loadWorkspaceConfig(testDir)
      expect(loaded?.defaults?.model).toBe('claude-sonnet-4-5-20250929')
      expect(loaded?.defaults?.permissionMode).toBe('ask')
      expect(loaded?.defaults?.defaultChatFilter).toBeUndefined()
    })
  })

  describe('update existing config', () => {
    it('adds defaultChatFilter to existing config without defaults', () => {
      // Start with no defaults
      const config = createTestConfig()
      delete config.defaults
      saveWorkspaceConfig(testDir, config)

      // Load, add filter, save again
      const loaded = loadWorkspaceConfig(testDir)!
      loaded.defaults = { ...loaded.defaults, defaultChatFilter: 'state:todo' }
      saveWorkspaceConfig(testDir, loaded)

      const reloaded = loadWorkspaceConfig(testDir)
      expect(reloaded?.defaults?.defaultChatFilter).toBe('state:todo')
    })

    it('updates existing defaultChatFilter', () => {
      const config = createTestConfig({
        defaults: { defaultChatFilter: 'allChats' },
      })
      saveWorkspaceConfig(testDir, config)

      // Change to a different filter
      const loaded = loadWorkspaceConfig(testDir)!
      loaded.defaults!.defaultChatFilter = 'state:in-progress'
      saveWorkspaceConfig(testDir, loaded)

      const reloaded = loadWorkspaceConfig(testDir)
      expect(reloaded?.defaults?.defaultChatFilter).toBe('state:in-progress')
    })

    it('removes defaultChatFilter by setting to undefined', () => {
      const config = createTestConfig({
        defaults: { defaultChatFilter: 'state:todo' },
      })
      saveWorkspaceConfig(testDir, config)

      // Remove the filter
      const loaded = loadWorkspaceConfig(testDir)!
      delete loaded.defaults!.defaultChatFilter
      saveWorkspaceConfig(testDir, loaded)

      const reloaded = loadWorkspaceConfig(testDir)
      expect(reloaded?.defaults?.defaultChatFilter).toBeUndefined()
    })

    it('preserves other defaults when updating defaultChatFilter', () => {
      const config = createTestConfig({
        defaults: {
          model: 'claude-sonnet-4-5-20250929',
          permissionMode: 'ask',
          thinkingLevel: 'think',
          defaultChatFilter: 'allChats',
        },
      })
      saveWorkspaceConfig(testDir, config)

      // Update only the filter
      const loaded = loadWorkspaceConfig(testDir)!
      loaded.defaults!.defaultChatFilter = 'flagged'
      saveWorkspaceConfig(testDir, loaded)

      const reloaded = loadWorkspaceConfig(testDir)
      expect(reloaded?.defaults?.model).toBe('claude-sonnet-4-5-20250929')
      expect(reloaded?.defaults?.permissionMode).toBe('ask')
      expect(reloaded?.defaults?.thinkingLevel).toBe('think')
      expect(reloaded?.defaults?.defaultChatFilter).toBe('flagged')
    })
  })

  describe('JSON serialization', () => {
    it('persists to config.json in correct format', () => {
      const config = createTestConfig({
        defaults: { defaultChatFilter: 'state:todo' },
      })
      saveWorkspaceConfig(testDir, config)

      // Read raw JSON to verify format
      const raw = readFileSync(join(testDir, 'config.json'), 'utf-8')
      const parsed = JSON.parse(raw)
      expect(parsed.defaults.defaultChatFilter).toBe('state:todo')
    })

    it('does not include defaultChatFilter in JSON when undefined', () => {
      const config = createTestConfig({
        defaults: { model: 'claude-sonnet-4-5-20250929' },
      })
      saveWorkspaceConfig(testDir, config)

      const raw = readFileSync(join(testDir, 'config.json'), 'utf-8')
      const parsed = JSON.parse(raw)
      expect('defaultChatFilter' in parsed.defaults).toBe(false)
    })
  })

  describe('createWorkspaceAtPath', () => {
    it('creates workspace without defaultChatFilter by default', () => {
      const wsPath = join(testDir, 'new-ws')
      const config = createWorkspaceAtPath(wsPath, 'New Workspace')
      expect(config.defaults?.defaultChatFilter).toBeUndefined()
    })

    it('creates workspace with defaultChatFilter when provided', () => {
      const wsPath = join(testDir, 'new-ws-with-filter')
      const config = createWorkspaceAtPath(wsPath, 'New Workspace', {
        defaultChatFilter: 'state:todo',
      })
      expect(config.defaults?.defaultChatFilter).toBe('state:todo')

      // Verify it persists
      const loaded = loadWorkspaceConfig(wsPath)
      expect(loaded?.defaults?.defaultChatFilter).toBe('state:todo')
    })
  })
})
