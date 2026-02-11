import { describe, it, expect } from 'bun:test'
import {
  parseCompoundRoute,
  buildCompoundRoute,
  parseRouteToNavigationState,
  buildRouteFromNavigationState,
} from '../route-parser'
import {
  getNavigationStateKey,
  parseNavigationStateKey,
  isAppsNavigation,
} from '../types'
import type { NavigationState } from '../types'

describe('Route Parser - Apps', () => {
  describe('parseCompoundRoute', () => {
    const cases = [
      {
        route: 'apps',
        expected: { navigator: 'apps' as const, details: null },
      },
      {
        route: 'apps/app/tickets',
        expected: { navigator: 'apps' as const, details: { type: 'app' as const, id: 'tickets' } },
      },
      {
        route: 'apps/app/tickets/view/list',
        expected: { navigator: 'apps' as const, details: { type: 'app' as const, id: 'tickets:list' } },
      },
      {
        route: 'apps/app/tickets/view/show',
        expected: { navigator: 'apps' as const, details: { type: 'app' as const, id: 'tickets:show' } },
      },
      {
        route: 'apps/invalid',
        expected: null,
      },
    ]

    for (const { route, expected } of cases) {
      it(`parses "${route}"`, () => {
        const result = parseCompoundRoute(route)
        if (expected === null) {
          expect(result).toBeNull()
        } else {
          expect(result).toEqual(expected)
        }
      })
    }
  })

  describe('parseRouteToNavigationState', () => {
    it('parses "apps" to apps navigator with no details', () => {
      const state = parseRouteToNavigationState('apps')
      expect(state).toEqual({ navigator: 'apps', details: null })
    })

    it('parses "apps/app/tickets" to app detail', () => {
      const state = parseRouteToNavigationState('apps/app/tickets')
      expect(state).toEqual({
        navigator: 'apps',
        details: { type: 'app', appSlug: 'tickets' },
      })
    })

    it('parses "apps/app/tickets/view/list" to app with viewId', () => {
      const state = parseRouteToNavigationState('apps/app/tickets/view/list')
      expect(state).toEqual({
        navigator: 'apps',
        details: { type: 'app', appSlug: 'tickets', viewId: 'list' },
      })
    })
  })

  describe('buildRouteFromNavigationState', () => {
    it('builds "apps" for empty apps state', () => {
      const route = buildRouteFromNavigationState({
        navigator: 'apps',
        details: null,
      })
      expect(route).toBe('apps')
    })

    it('builds "apps/app/tickets" for app detail', () => {
      const route = buildRouteFromNavigationState({
        navigator: 'apps',
        details: { type: 'app', appSlug: 'tickets' },
      })
      expect(route).toBe('apps/app/tickets')
    })

    it('builds "apps/app/tickets/view/list" for app with viewId', () => {
      const route = buildRouteFromNavigationState({
        navigator: 'apps',
        details: { type: 'app', appSlug: 'tickets', viewId: 'list' },
      })
      expect(route).toBe('apps/app/tickets/view/list')
    })
  })

  describe('round-trip', () => {
    const routes = [
      'apps',
      'apps/app/tickets',
      'apps/app/tickets/view/list',
      'apps/app/my-dashboard/view/overview',
    ]

    for (const route of routes) {
      it(`round-trips "${route}"`, () => {
        const state = parseRouteToNavigationState(route)
        expect(state).not.toBeNull()
        const rebuilt = buildRouteFromNavigationState(state!)
        expect(rebuilt).toBe(route)
      })
    }
  })

  describe('getNavigationStateKey / parseNavigationStateKey', () => {
    it('round-trips apps state with no details', () => {
      const state: NavigationState = { navigator: 'apps', details: null }
      const key = getNavigationStateKey(state)
      expect(key).toBe('apps')
      const parsed = parseNavigationStateKey(key)
      expect(parsed).toEqual(state)
    })

    it('round-trips apps state with app detail', () => {
      const state: NavigationState = {
        navigator: 'apps',
        details: { type: 'app', appSlug: 'tickets' },
      }
      const key = getNavigationStateKey(state)
      expect(key).toBe('apps/app/tickets')
      const parsed = parseNavigationStateKey(key)
      expect(parsed).toEqual(state)
    })
  })

  describe('isAppsNavigation type guard', () => {
    it('returns true for apps state', () => {
      const state: NavigationState = { navigator: 'apps', details: null }
      expect(isAppsNavigation(state)).toBe(true)
    })

    it('returns false for sessions state', () => {
      const state: NavigationState = {
        navigator: 'sessions',
        filter: { kind: 'allSessions' },
        details: null,
      }
      expect(isAppsNavigation(state)).toBe(false)
    })

    it('returns false for queue state', () => {
      const state: NavigationState = { navigator: 'queue', details: null }
      expect(isAppsNavigation(state)).toBe(false)
    })
  })
})
