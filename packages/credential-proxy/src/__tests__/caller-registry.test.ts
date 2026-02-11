import { describe, it, expect, beforeEach } from 'bun:test';
import { CallerRegistry, type PermissionMode } from '../caller-registry';

describe('CallerRegistry', () => {
  let registry: CallerRegistry;

  beforeEach(() => {
    registry = new CallerRegistry();
  });

  describe('register / unregister', () => {
    it('registers a session caller and tracks it', () => {
      registry.register('s1', 'session', 'allow-all');
      expect(registry.has('s1')).toBe(true);
      expect(registry.size).toBe(1);
    });

    it('registers an app caller and tracks it', () => {
      registry.register('my-app', 'app', 'safe');
      expect(registry.has('my-app')).toBe(true);
      expect(registry.getCallerType('my-app')).toBe('app');
      expect(registry.size).toBe(1);
    });

    it('unregisters a caller', () => {
      registry.register('s1', 'session', 'allow-all');
      registry.unregister('s1');
      expect(registry.has('s1')).toBe(false);
      expect(registry.size).toBe(0);
    });

    it('handles unregistering a non-existent caller gracefully', () => {
      registry.unregister('nonexistent');
      expect(registry.size).toBe(0);
    });

    it('tracks multiple callers independently', () => {
      registry.register('s1', 'session', 'allow-all');
      registry.register('s2', 'session', 'safe');
      registry.register('my-app', 'app', 'safe');
      expect(registry.size).toBe(3);

      registry.unregister('s2');
      expect(registry.size).toBe(2);
      expect(registry.has('s1')).toBe(true);
      expect(registry.has('s2')).toBe(false);
      expect(registry.has('my-app')).toBe(true);
    });
  });

  describe('getMode', () => {
    it('returns the registered permission mode', () => {
      registry.register('s1', 'session', 'allow-all');
      expect(registry.getMode('s1')).toBe('allow-all');
    });

    it('defaults to safe for unknown callers', () => {
      expect(registry.getMode('unknown')).toBe('safe');
    });

    it('returns correct mode for each caller', () => {
      registry.register('s1', 'session', 'allow-all');
      registry.register('s2', 'session', 'safe');
      registry.register('my-app', 'app', 'ask');

      expect(registry.getMode('s1')).toBe('allow-all');
      expect(registry.getMode('s2')).toBe('safe');
      expect(registry.getMode('my-app')).toBe('ask');
    });
  });

  describe('getCallerType', () => {
    it('returns session for session callers', () => {
      registry.register('s1', 'session', 'safe');
      expect(registry.getCallerType('s1')).toBe('session');
    });

    it('returns app for app callers', () => {
      registry.register('my-app', 'app', 'safe');
      expect(registry.getCallerType('my-app')).toBe('app');
    });

    it('returns null for unknown callers', () => {
      expect(registry.getCallerType('unknown')).toBeNull();
    });
  });

  describe('updateMode', () => {
    it('updates a caller permission mode', () => {
      registry.register('s1', 'session', 'safe');
      expect(registry.getMode('s1')).toBe('safe');

      registry.updateMode('s1', 'allow-all');
      expect(registry.getMode('s1')).toBe('allow-all');
    });

    it('updates an app caller permission mode', () => {
      registry.register('my-app', 'app', 'safe');
      registry.updateMode('my-app', 'allow-all');
      expect(registry.getMode('my-app')).toBe('allow-all');
      // Type should not change
      expect(registry.getCallerType('my-app')).toBe('app');
    });

    it('silently ignores updates for non-existent callers', () => {
      registry.updateMode('nonexistent', 'allow-all');
      expect(registry.has('nonexistent')).toBe(false);
      expect(registry.getMode('nonexistent')).toBe('safe');
    });

    it('takes effect immediately for subsequent getMode calls', () => {
      registry.register('s1', 'session', 'safe');

      const modes: PermissionMode[] = ['safe', 'ask', 'allow-all', 'safe'];
      for (const mode of modes) {
        registry.updateMode('s1', mode);
        expect(registry.getMode('s1')).toBe(mode);
      }
    });
  });

  describe('getCallerIds', () => {
    it('returns empty array when no callers registered', () => {
      expect(registry.getCallerIds()).toEqual([]);
    });

    it('returns all registered caller IDs', () => {
      registry.register('s1', 'session', 'safe');
      registry.register('my-app', 'app', 'allow-all');
      const ids = registry.getCallerIds();
      expect(ids).toContain('s1');
      expect(ids).toContain('my-app');
      expect(ids.length).toBe(2);
    });
  });

  describe('clear', () => {
    it('removes all callers', () => {
      registry.register('s1', 'session', 'safe');
      registry.register('s2', 'session', 'allow-all');
      registry.register('my-app', 'app', 'ask');

      registry.clear();
      expect(registry.size).toBe(0);
      expect(registry.getCallerIds()).toEqual([]);
    });
  });
});
