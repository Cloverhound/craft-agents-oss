/**
 * Tests for extractWorkspaceSlug utility and qualifySkillName
 *
 * extractWorkspaceSlug (packages/shared/src/utils/workspace.ts) is used in
 * ClaudeAgent, CodexAgent, and renderer components to derive the workspace
 * slug from rootPath for skill qualification.
 *
 * This file tests:
 * 1. The extractWorkspaceSlug utility directly
 * 2. qualifySkillName which consumes the slug
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { qualifySkillName, AGENTS_PLUGIN_NAME } from '../core/index.ts'
import { extractWorkspaceSlug } from '../../utils/workspace.ts'

describe('workspace slug extraction', () => {
  const fallback = 'fallback-id'

  it('extracts slug from normal path', () => {
    expect(extractWorkspaceSlug('/Users/foo/my-workspace', fallback)).toBe('my-workspace')
  })

  it('extracts slug from path with trailing slash', () => {
    expect(extractWorkspaceSlug('/path/workspace/', fallback)).toBe('workspace')
  })

  it('extracts slug from deep path', () => {
    expect(extractWorkspaceSlug('/a/b/c/d/workspace', fallback)).toBe('workspace')
  })

  it('extracts slug from single-component path', () => {
    expect(extractWorkspaceSlug('/workspace', fallback)).toBe('workspace')
  })

  it('returns fallback for root path /', () => {
    // split('/').filter(Boolean) on '/' gives []
    // [].at(-1) is undefined, so fallback is used
    expect(extractWorkspaceSlug('/', fallback)).toBe(fallback)
  })

  it('returns fallback for empty string', () => {
    // split('/').filter(Boolean) on '' gives []
    expect(extractWorkspaceSlug('', fallback)).toBe(fallback)
  })

  it('handles Windows-style paths with forward slashes', () => {
    // In practice the code splits on '/' which works if paths are normalized
    expect(extractWorkspaceSlug('C:/Users/foo/workspace', fallback)).toBe('workspace')
  })

  it('handles hyphenated workspace names', () => {
    expect(extractWorkspaceSlug('/path/to/my-cool-workspace', fallback)).toBe('my-cool-workspace')
  })

  it('handles dotted workspace names', () => {
    expect(extractWorkspaceSlug('/path/to/my.workspace-name', fallback)).toBe('my.workspace-name')
  })

  it('handles workspace names with underscores', () => {
    expect(extractWorkspaceSlug('/path/to/my_workspace', fallback)).toBe('my_workspace')
  })

  it('handles paths with spaces in components', () => {
    expect(extractWorkspaceSlug('/Users/John Smith/My Workspace', fallback)).toBe('My Workspace')
  })

  it('handles multiple trailing slashes', () => {
    // filter(Boolean) removes empty strings from split
    expect(extractWorkspaceSlug('/path/workspace///', fallback)).toBe('workspace')
  })
})

// ============================================================================
// qualifySkillName — uses the workspace slug to prefix skill names
// ============================================================================

describe('qualifySkillName', () => {
  it('qualifies a bare skill name with workspace slug', () => {
    const result = qualifySkillName({ skill: 'commit' }, 'my-workspace')
    expect(result.modified).toBe(true)
    expect(result.input).toEqual({ skill: 'my-workspace:commit' })
  })

  it('does not modify already-qualified skill names', () => {
    const result = qualifySkillName({ skill: 'my-workspace:commit' }, 'my-workspace')
    expect(result.modified).toBe(false)
    expect(result.input).toEqual({ skill: 'my-workspace:commit' })
  })

  it('does not modify skill with different workspace prefix', () => {
    const result = qualifySkillName({ skill: 'other-ws:commit' }, 'my-workspace')
    expect(result.modified).toBe(false)
    expect(result.input).toEqual({ skill: 'other-ws:commit' })
  })

  it('handles missing skill field', () => {
    const result = qualifySkillName({ args: 'something' }, 'my-workspace')
    expect(result.modified).toBe(false)
  })

  it('handles undefined skill field', () => {
    const result = qualifySkillName({ skill: undefined }, 'my-workspace')
    expect(result.modified).toBe(false)
  })

  it('preserves other input fields when qualifying', () => {
    const result = qualifySkillName({ skill: 'commit', args: '-m "fix"' }, 'my-workspace')
    expect(result.modified).toBe(true)
    expect(result.input).toEqual({ skill: 'my-workspace:commit', args: '-m "fix"' })
  })

  it('calls debug callback when qualifying', () => {
    const messages: string[] = []
    qualifySkillName({ skill: 'commit' }, 'my-workspace', undefined, undefined, (msg) => messages.push(msg))
    expect(messages.length).toBe(1)
    expect(messages[0]).toContain('qualified')
    expect(messages[0]).toContain('commit')
    expect(messages[0]).toContain('my-workspace:commit')
  })

  it('does not call debug callback when skill is missing', () => {
    const messages: string[] = []
    qualifySkillName({ skill: undefined }, 'my-workspace', undefined, undefined, (msg) => messages.push(msg))
    expect(messages.length).toBe(0)
  })

  it('works with dotted workspace slug', () => {
    const result = qualifySkillName({ skill: 'commit' }, 'my.workspace')
    expect(result.modified).toBe(true)
    expect(result.input).toEqual({ skill: 'my.workspace:commit' })
  })

  it('works with hyphenated skill names', () => {
    const result = qualifySkillName({ skill: 'review-pr' }, 'workspace')
    expect(result.modified).toBe(true)
    expect(result.input).toEqual({ skill: 'workspace:review-pr' })
  })

  it('handles empty slug from trailing colon', () => {
    const result = qualifySkillName({ skill: 'workspace:' }, 'my-workspace')
    expect(result.modified).toBe(false)
  })
})

// ============================================================================
// qualifySkillName with filesystem resolution (resolveSkillPlugin path)
// ============================================================================

describe('qualifySkillName with filesystem resolution', () => {
  const testDir = join(tmpdir(), `skill-resolve-test-${Date.now()}`)
  const workspaceRoot = join(testDir, 'my-workspace')
  const projectDir = join(testDir, 'my-project')
  const workspaceSlug = 'my-workspace'

  beforeAll(() => {
    // Create workspace skill: my-workspace/skills/ws-only/SKILL.md
    mkdirSync(join(workspaceRoot, 'skills', 'ws-only'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'skills', 'ws-only', 'SKILL.md'), '---\nname: WS Only\ndescription: test\n---\n')

    // Create workspace skill that also exists in project (for priority test)
    mkdirSync(join(workspaceRoot, 'skills', 'shared-skill'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'skills', 'shared-skill', 'SKILL.md'), '---\nname: WS Shared\ndescription: test\n---\n')

    // Create project skill: my-project/.agents/skills/proj-only/SKILL.md
    mkdirSync(join(projectDir, '.agents', 'skills', 'proj-only'), { recursive: true })
    writeFileSync(join(projectDir, '.agents', 'skills', 'proj-only', 'SKILL.md'), '---\nname: Proj Only\ndescription: test\n---\n')

    // Create project skill that also exists in workspace (for priority test)
    mkdirSync(join(projectDir, '.agents', 'skills', 'shared-skill'), { recursive: true })
    writeFileSync(join(projectDir, '.agents', 'skills', 'shared-skill', 'SKILL.md'), '---\nname: Proj Shared\ndescription: test\n---\n')
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('resolves workspace-only skill to workspace plugin', () => {
    const result = qualifySkillName({ skill: 'ws-only' }, workspaceSlug, workspaceRoot, projectDir)
    expect(result.modified).toBe(true)
    expect(result.input).toEqual({ skill: 'my-workspace:ws-only' })
  })

  it('resolves project-only skill to .agents plugin', () => {
    const result = qualifySkillName({ skill: 'proj-only' }, workspaceSlug, workspaceRoot, projectDir)
    expect(result.modified).toBe(true)
    expect(result.input).toEqual({ skill: `${AGENTS_PLUGIN_NAME}:proj-only` })
  })

  it('project skill takes priority over workspace skill (same slug)', () => {
    const result = qualifySkillName({ skill: 'shared-skill' }, workspaceSlug, workspaceRoot, projectDir)
    expect(result.modified).toBe(true)
    // Project has higher priority than workspace — should resolve to .agents:
    expect(result.input).toEqual({ skill: `${AGENTS_PLUGIN_NAME}:shared-skill` })
  })

  it('re-qualifies incorrectly qualified skill (workspace prefix for project skill)', () => {
    // UI might send "my-workspace:proj-only" but proj-only only exists in project tier
    const result = qualifySkillName({ skill: 'my-workspace:proj-only' }, workspaceSlug, workspaceRoot, projectDir)
    expect(result.modified).toBe(true)
    expect(result.input).toEqual({ skill: `${AGENTS_PLUGIN_NAME}:proj-only` })
  })

  it('does not modify correctly qualified workspace skill', () => {
    const result = qualifySkillName({ skill: 'my-workspace:ws-only' }, workspaceSlug, workspaceRoot, projectDir)
    expect(result.modified).toBe(false)
  })

  it('falls back to workspace plugin for unknown skill', () => {
    const result = qualifySkillName({ skill: 'nonexistent' }, workspaceSlug, workspaceRoot, projectDir)
    expect(result.modified).toBe(true)
    expect(result.input).toEqual({ skill: 'my-workspace:nonexistent' })
  })

  it('resolves without project dir (workspace-only mode)', () => {
    const result = qualifySkillName({ skill: 'ws-only' }, workspaceSlug, workspaceRoot, undefined)
    expect(result.modified).toBe(true)
    expect(result.input).toEqual({ skill: 'my-workspace:ws-only' })
  })
})
