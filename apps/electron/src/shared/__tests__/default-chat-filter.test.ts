/**
 * Tests for default chat filter parsing, serialization, and route building.
 *
 * These tests verify:
 * - parseDefaultChatFilter: string → SessionFilter (with validation)
 * - serializeChatFilter: SessionFilter → string (round-trip)
 * - buildDefaultViewRoute: string → Route (view route from filter string)
 * - Edge cases: invalid strings, undefined, empty strings, etc.
 */
import { describe, it, expect } from 'bun:test'
import {
  parseDefaultChatFilter,
  serializeChatFilter,
  type SessionFilter,
} from '../types'
import { buildDefaultViewRoute } from '../routes'

// ============================================================
// parseDefaultChatFilter
// ============================================================

describe('parseDefaultChatFilter', () => {
  describe('valid filter strings', () => {
    it('parses "allChats" to allSessions filter', () => {
      const result = parseDefaultChatFilter('allChats')
      expect(result).toEqual({ kind: 'allSessions' })
    })

    it('parses "flagged" to flagged filter', () => {
      const result = parseDefaultChatFilter('flagged')
      expect(result).toEqual({ kind: 'flagged' })
    })

    it('parses "state:{id}" to state filter', () => {
      const result = parseDefaultChatFilter('state:todo')
      expect(result).toEqual({ kind: 'state', stateId: 'todo' })
    })

    it('parses state filter with hyphenated ID', () => {
      const result = parseDefaultChatFilter('state:in-progress')
      expect(result).toEqual({ kind: 'state', stateId: 'in-progress' })
    })

    it('parses state filter with custom status ID', () => {
      const result = parseDefaultChatFilter('state:needs-review')
      expect(result).toEqual({ kind: 'state', stateId: 'needs-review' })
    })

    it('parses "label:{id}" to label filter', () => {
      const result = parseDefaultChatFilter('label:priority')
      expect(result).toEqual({ kind: 'label', labelId: 'priority' })
    })

    it('parses label filter with hyphenated ID', () => {
      const result = parseDefaultChatFilter('label:high-priority')
      expect(result).toEqual({ kind: 'label', labelId: 'high-priority' })
    })

    it('parses "view:{id}" to view filter', () => {
      const result = parseDefaultChatFilter('view:my-custom-view')
      expect(result).toEqual({ kind: 'view', viewId: 'my-custom-view' })
    })

    it('parses view filter with UUID-style ID', () => {
      const result = parseDefaultChatFilter('view:abc-123-def')
      expect(result).toEqual({ kind: 'view', viewId: 'abc-123-def' })
    })
  })

  describe('invalid/missing filter strings', () => {
    it('returns null for undefined', () => {
      expect(parseDefaultChatFilter(undefined)).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(parseDefaultChatFilter('')).toBeNull()
    })

    it('returns null for unknown filter kind', () => {
      expect(parseDefaultChatFilter('unknown')).toBeNull()
    })

    it('returns null for "state:" with no ID', () => {
      expect(parseDefaultChatFilter('state:')).toBeNull()
    })

    it('returns null for "label:" with no ID', () => {
      expect(parseDefaultChatFilter('label:')).toBeNull()
    })

    it('returns null for "view:" with no ID', () => {
      expect(parseDefaultChatFilter('view:')).toBeNull()
    })

    it('returns null for arbitrary strings', () => {
      expect(parseDefaultChatFilter('foo')).toBeNull()
      expect(parseDefaultChatFilter('bar:baz')).toBeNull()
      expect(parseDefaultChatFilter('123')).toBeNull()
    })

    it('returns null for strings with correct prefix but wrong separator', () => {
      expect(parseDefaultChatFilter('state-todo')).toBeNull()
      expect(parseDefaultChatFilter('label/priority')).toBeNull()
    })
  })
})

// ============================================================
// serializeChatFilter
// ============================================================

describe('serializeChatFilter', () => {
  it('serializes allSessions filter', () => {
    expect(serializeChatFilter({ kind: 'allSessions' })).toBe('allChats')
  })

  it('serializes flagged filter', () => {
    expect(serializeChatFilter({ kind: 'flagged' })).toBe('flagged')
  })

  it('serializes state filter', () => {
    expect(serializeChatFilter({ kind: 'state', stateId: 'todo' })).toBe('state:todo')
  })

  it('serializes state filter with hyphenated ID', () => {
    expect(serializeChatFilter({ kind: 'state', stateId: 'in-progress' })).toBe('state:in-progress')
  })

  it('serializes label filter', () => {
    expect(serializeChatFilter({ kind: 'label', labelId: 'priority' })).toBe('label:priority')
  })

  it('serializes view filter', () => {
    expect(serializeChatFilter({ kind: 'view', viewId: 'my-view' })).toBe('view:my-view')
  })
})

// ============================================================
// Round-trip: serialize → parse
// ============================================================

describe('round-trip (serialize → parse)', () => {
  const testCases: SessionFilter[] = [
    { kind: 'allSessions' },
    { kind: 'flagged' },
    { kind: 'state', stateId: 'todo' },
    { kind: 'state', stateId: 'in-progress' },
    { kind: 'state', stateId: 'done' },
    { kind: 'state', stateId: 'cancelled' },
    { kind: 'state', stateId: 'needs-review' },
    { kind: 'state', stateId: 'custom-status' },
    { kind: 'label', labelId: 'priority' },
    { kind: 'label', labelId: 'team-backend' },
    { kind: 'view', viewId: 'my-view' },
    { kind: 'view', viewId: 'complex-view-id-123' },
  ]

  for (const filter of testCases) {
    it(`round-trips ${JSON.stringify(filter)}`, () => {
      const serialized = serializeChatFilter(filter)
      const parsed = parseDefaultChatFilter(serialized)
      expect(parsed).toEqual(filter)
    })
  }
})

// ============================================================
// buildDefaultViewRoute
// ============================================================

describe('buildDefaultViewRoute', () => {
  describe('without session ID', () => {
    it('returns allSessions route for undefined filter', () => {
      expect(buildDefaultViewRoute(undefined)).toBe('allSessions')
    })

    it('returns allSessions route for "allChats" filter', () => {
      expect(buildDefaultViewRoute('allChats')).toBe('allSessions')
    })

    it('returns flagged route for "flagged" filter', () => {
      expect(buildDefaultViewRoute('flagged')).toBe('flagged')
    })

    it('returns state route for "state:{id}" filter', () => {
      expect(buildDefaultViewRoute('state:in-progress')).toBe('state/in-progress')
    })

    it('returns label route for "label:{id}" filter', () => {
      expect(buildDefaultViewRoute('label:priority')).toBe('label/priority')
    })

    it('returns view route for "view:{id}" filter', () => {
      expect(buildDefaultViewRoute('view:my-view')).toBe('view/my-view')
    })

    it('falls back to allSessions for unknown filter format', () => {
      expect(buildDefaultViewRoute('unknown')).toBe('allSessions')
    })

    it('falls back to allSessions for empty string', () => {
      expect(buildDefaultViewRoute('')).toBe('allSessions')
    })

    it('falls back to allSessions for "state:" with no ID', () => {
      expect(buildDefaultViewRoute('state:')).toBe('allSessions')
    })

    it('falls back to allSessions for "label:" with no ID', () => {
      expect(buildDefaultViewRoute('label:')).toBe('allSessions')
    })

    it('falls back to allSessions for "view:" with no ID', () => {
      expect(buildDefaultViewRoute('view:')).toBe('allSessions')
    })
  })

  describe('with session ID', () => {
    const sessionId = 'session-abc-123'

    it('returns allSessions/session/{id} route for undefined filter', () => {
      expect(buildDefaultViewRoute(undefined, sessionId)).toBe(`allSessions/session/${sessionId}`)
    })

    it('returns allSessions/session/{id} route for "allChats" filter', () => {
      expect(buildDefaultViewRoute('allChats', sessionId)).toBe(`allSessions/session/${sessionId}`)
    })

    it('returns flagged/session/{id} route for "flagged" filter', () => {
      expect(buildDefaultViewRoute('flagged', sessionId)).toBe(`flagged/session/${sessionId}`)
    })

    it('returns state/{stateId}/session/{id} for state filter', () => {
      expect(buildDefaultViewRoute('state:in-progress', sessionId)).toBe(`state/in-progress/session/${sessionId}`)
    })

    it('returns label/{labelId}/session/{id} for label filter', () => {
      expect(buildDefaultViewRoute('label:priority', sessionId)).toBe(`label/priority/session/${sessionId}`)
    })

    it('returns view/{viewId}/session/{id} for view filter', () => {
      expect(buildDefaultViewRoute('view:my-view', sessionId)).toBe(`view/my-view/session/${sessionId}`)
    })

    it('falls back to allSessions/session/{id} for invalid filter', () => {
      expect(buildDefaultViewRoute('bogus', sessionId)).toBe(`allSessions/session/${sessionId}`)
    })
  })

  describe('label/view URL encoding', () => {
    it('encodes special characters in label IDs', () => {
      const route = buildDefaultViewRoute('label:my label')
      expect(route).toBe('label/my%20label')
    })

    it('encodes special characters in view IDs', () => {
      const route = buildDefaultViewRoute('view:my view')
      expect(route).toBe('view/my%20view')
    })
  })
})
