import { describe, it, expect, beforeEach } from 'bun:test';
import { SessionRegistry, type PermissionMode } from '../session-registry';

describe('SessionRegistry', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
  });

  describe('register / unregister', () => {
    it('registers a session and tracks it', () => {
      registry.register('s1', 'allow-all');
      expect(registry.has('s1')).toBe(true);
      expect(registry.size).toBe(1);
    });

    it('unregisters a session', () => {
      registry.register('s1', 'allow-all');
      registry.unregister('s1');
      expect(registry.has('s1')).toBe(false);
      expect(registry.size).toBe(0);
    });

    it('handles unregistering a non-existent session gracefully', () => {
      registry.unregister('nonexistent');
      expect(registry.size).toBe(0);
    });

    it('tracks multiple sessions independently', () => {
      registry.register('s1', 'allow-all');
      registry.register('s2', 'safe');
      registry.register('s3', 'ask');
      expect(registry.size).toBe(3);

      registry.unregister('s2');
      expect(registry.size).toBe(2);
      expect(registry.has('s1')).toBe(true);
      expect(registry.has('s2')).toBe(false);
      expect(registry.has('s3')).toBe(true);
    });
  });

  describe('getMode', () => {
    it('returns the registered permission mode', () => {
      registry.register('s1', 'allow-all');
      expect(registry.getMode('s1')).toBe('allow-all');
    });

    it('defaults to safe for unknown sessions', () => {
      expect(registry.getMode('unknown')).toBe('safe');
    });

    it('returns correct mode for each session', () => {
      registry.register('s1', 'allow-all');
      registry.register('s2', 'safe');
      registry.register('s3', 'ask');

      expect(registry.getMode('s1')).toBe('allow-all');
      expect(registry.getMode('s2')).toBe('safe');
      expect(registry.getMode('s3')).toBe('ask');
    });
  });

  describe('updateMode', () => {
    it('updates a session permission mode', () => {
      registry.register('s1', 'safe');
      expect(registry.getMode('s1')).toBe('safe');

      registry.updateMode('s1', 'allow-all');
      expect(registry.getMode('s1')).toBe('allow-all');
    });

    it('silently ignores updates for non-existent sessions', () => {
      registry.updateMode('nonexistent', 'allow-all');
      // Should not create the session
      expect(registry.has('nonexistent')).toBe(false);
      // Should still default to safe
      expect(registry.getMode('nonexistent')).toBe('safe');
    });

    it('takes effect immediately for subsequent getMode calls', () => {
      registry.register('s1', 'safe');

      const modes: PermissionMode[] = ['safe', 'ask', 'allow-all', 'safe'];
      for (const mode of modes) {
        registry.updateMode('s1', mode);
        expect(registry.getMode('s1')).toBe(mode);
      }
    });
  });

  describe('getSessionIds', () => {
    it('returns empty array when no sessions registered', () => {
      expect(registry.getSessionIds()).toEqual([]);
    });

    it('returns all registered session IDs', () => {
      registry.register('s1', 'safe');
      registry.register('s2', 'allow-all');
      const ids = registry.getSessionIds();
      expect(ids).toContain('s1');
      expect(ids).toContain('s2');
      expect(ids.length).toBe(2);
    });
  });

  describe('clear', () => {
    it('removes all sessions', () => {
      registry.register('s1', 'safe');
      registry.register('s2', 'allow-all');
      registry.register('s3', 'ask');

      registry.clear();
      expect(registry.size).toBe(0);
      expect(registry.getSessionIds()).toEqual([]);
    });
  });
});
