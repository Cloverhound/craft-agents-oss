/**
 * Session Registry
 *
 * Maps session IDs to their permission mode, enabling per-session
 * enforcement of Explore/Execute restrictions in the proxy.
 *
 * Sessions register when created and unregister when destroyed.
 * Permission mode can be updated mid-session (takes effect immediately
 * for the next request).
 */

export type PermissionMode = 'safe' | 'ask' | 'allow-all';

export interface SessionInfo {
  permissionMode: PermissionMode;
}

export class SessionRegistry {
  private sessions = new Map<string, SessionInfo>();

  /**
   * Register a session with its initial permission mode.
   */
  register(sessionId: string, permissionMode: PermissionMode): void {
    this.sessions.set(sessionId, { permissionMode });
  }

  /**
   * Unregister a session (on destroy/delete).
   */
  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Update a session's permission mode (e.g., user toggles Explore ↔ Execute).
   */
  updateMode(sessionId: string, permissionMode: PermissionMode): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.permissionMode = permissionMode;
    }
  }

  /**
   * Get a session's current permission mode.
   * Unknown sessions default to 'safe' (Explore) for safety.
   */
  getMode(sessionId: string): PermissionMode {
    return this.sessions.get(sessionId)?.permissionMode ?? 'safe';
  }

  /**
   * Check if a session is registered.
   */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get count of registered sessions.
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Get all registered session IDs.
   */
  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Clear all sessions.
   */
  clear(): void {
    this.sessions.clear();
  }
}
