import { describe, it, expect } from 'bun:test'
import { DOC_REFS } from '../src/docs/index.ts'
import { getSystemPrompt } from '../src/prompts/system.ts'

describe('apps docs prompt guidance', () => {
  it('exposes DOC_REFS.apps path', () => {
    expect(DOC_REFS.apps).toBe('~/.craft-agent/docs/apps.md')
  })

  it('includes explicit apps doc instruction before app modifications', () => {
    const prompt = getSystemPrompt(undefined, undefined, '/tmp/workspaces/my-workspace')
    expect(prompt).toContain(`Before creating/modifying apps`)
    expect(prompt).toContain(DOC_REFS.apps)
  })

  it('includes apps row in Configuration Documentation table', () => {
    const prompt = getSystemPrompt(undefined, undefined, '/tmp/workspaces/my-workspace')
    expect(prompt).toContain(`| Apps | \`${DOC_REFS.apps}\` | BEFORE creating/modifying apps |`)
  })
})

