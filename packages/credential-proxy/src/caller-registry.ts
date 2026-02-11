/**
 * Caller Registry
 *
 * Maps caller IDs to their type and permission mode, enabling per-caller
 * enforcement of Explore/Execute restrictions in the proxy.
 *
 * Callers can be sessions (agent conversations) or apps (custom apps
 * making authenticated API requests via scripts).
 *
 * Callers register when created and unregister when destroyed.
 * Permission mode can be updated mid-lifecycle (takes effect immediately
 * for the next request).
 */

export type PermissionMode = 'safe' | 'ask' | 'allow-all';

export type CallerType = 'session' | 'app';

export interface CallerInfo {
  callerType: CallerType;
  permissionMode: PermissionMode;
}

export class CallerRegistry {
  private callers = new Map<string, CallerInfo>();

  /**
   * Register a caller with its type and initial permission mode.
   */
  register(callerId: string, callerType: CallerType, permissionMode: PermissionMode): void {
    this.callers.set(callerId, { callerType, permissionMode });
  }

  /**
   * Unregister a caller (on destroy/delete).
   */
  unregister(callerId: string): void {
    this.callers.delete(callerId);
  }

  /**
   * Update a caller's permission mode (e.g., user toggles Explore ↔ Execute).
   */
  updateMode(callerId: string, permissionMode: PermissionMode): void {
    const info = this.callers.get(callerId);
    if (info) {
      info.permissionMode = permissionMode;
    }
  }

  /**
   * Get a caller's current permission mode.
   * Unknown callers default to 'safe' (Explore) for safety.
   */
  getMode(callerId: string): PermissionMode {
    return this.callers.get(callerId)?.permissionMode ?? 'safe';
  }

  /**
   * Get a caller's type, or null if not registered.
   */
  getCallerType(callerId: string): CallerType | null {
    return this.callers.get(callerId)?.callerType ?? null;
  }

  /**
   * Check if a caller is registered.
   */
  has(callerId: string): boolean {
    return this.callers.has(callerId);
  }

  /**
   * Get count of registered callers.
   */
  get size(): number {
    return this.callers.size;
  }

  /**
   * Get all registered caller IDs.
   */
  getCallerIds(): string[] {
    return Array.from(this.callers.keys());
  }

  /**
   * Clear all callers.
   */
  clear(): void {
    this.callers.clear();
  }
}
