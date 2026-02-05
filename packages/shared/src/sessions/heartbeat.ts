/**
 * Session Heartbeat for Multi-Instance Detection
 *
 * Provides activity-based detection of concurrent session access across
 * multiple app instances. A heartbeat is active when:
 * - A response is streaming, OR
 * - Background tasks are running
 *
 * The heartbeat is written periodically (every 5s) while active.
 * Other instances check the heartbeat before sending messages and
 * show a warning if another instance is actively using the session.
 *
 * This is non-blocking - users can proceed despite the warning.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

/**
 * Heartbeat data written to the session directory.
 */
export interface Heartbeat {
  /** Unique identifier for this app instance */
  instanceId: string;
  /** Timestamp when heartbeat was last updated */
  timestamp: number;
  /** Number of background tasks currently running */
  activeBackgroundTasks: number;
  /** Whether a response is currently streaming */
  isStreaming: boolean;
}

/** Heartbeat is considered stale after this many milliseconds */
const HEARTBEAT_STALE_MS = 30_000; // 30 seconds

/** Recommended interval for updating heartbeat while active */
export const HEARTBEAT_UPDATE_INTERVAL_MS = 5_000; // 5 seconds

/**
 * Get the path to the heartbeat file for a session.
 *
 * @param sessionDir - Path to the session directory
 * @returns Path to heartbeat.json
 */
export function getHeartbeatPath(sessionDir: string): string {
  return join(sessionDir, 'heartbeat.json');
}

/**
 * Write/update the heartbeat file.
 * Should be called periodically while the session is active.
 *
 * @param sessionDir - Path to the session directory
 * @param instanceId - Unique identifier for this app instance
 * @param activeBackgroundTasks - Number of background tasks running
 * @param isStreaming - Whether a response is currently streaming
 */
export function writeHeartbeat(
  sessionDir: string,
  instanceId: string,
  activeBackgroundTasks: number,
  isStreaming: boolean
): void {
  const heartbeat: Heartbeat = {
    instanceId,
    timestamp: Date.now(),
    activeBackgroundTasks,
    isStreaming,
  };

  const path = getHeartbeatPath(sessionDir);
  try {
    // Atomic write via temp file
    const tempPath = path + '.tmp';
    writeFileSync(tempPath, JSON.stringify(heartbeat), 'utf-8');
    // Rename is atomic on POSIX, mostly atomic on Windows
    const fs = require('fs');
    fs.renameSync(tempPath, path);
  } catch {
    // Best effort - don't fail if we can't write heartbeat
    try {
      writeFileSync(path, JSON.stringify(heartbeat), 'utf-8');
    } catch {
      // Ignore - heartbeat is non-critical
    }
  }
}

/**
 * Read the heartbeat file for a session.
 *
 * @param sessionDir - Path to the session directory
 * @returns Heartbeat data, or null if file doesn't exist or is invalid
 */
export function readHeartbeat(sessionDir: string): Heartbeat | null {
  const path = getHeartbeatPath(sessionDir);

  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const data = JSON.parse(content);

    // Validate structure
    if (
      typeof data.instanceId !== 'string' ||
      typeof data.timestamp !== 'number' ||
      typeof data.activeBackgroundTasks !== 'number'
    ) {
      return null;
    }

    return data as Heartbeat;
  } catch {
    return null;
  }
}

/**
 * Clear/remove the heartbeat file.
 * Should be called when session activity ends.
 *
 * @param sessionDir - Path to the session directory
 */
export function clearHeartbeat(sessionDir: string): void {
  const path = getHeartbeatPath(sessionDir);

  try {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    // Ignore - best effort cleanup
  }

  // Also clean up any stale temp file
  const tempPath = path + '.tmp';
  try {
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
  } catch {
    // Ignore
  }
}

/**
 * Check if a heartbeat indicates another instance is actively using the session.
 *
 * @param heartbeat - Heartbeat data to check (can be null)
 * @param myInstanceId - This instance's ID (to exclude self)
 * @returns true if another instance is actively using the session
 */
export function isHeartbeatActive(heartbeat: Heartbeat | null, myInstanceId: string): boolean {
  if (!heartbeat) {
    return false;
  }

  // Ignore our own heartbeat
  if (heartbeat.instanceId === myInstanceId) {
    return false;
  }

  // Check if heartbeat is fresh (not stale)
  const age = Date.now() - heartbeat.timestamp;
  if (age > HEARTBEAT_STALE_MS) {
    return false;
  }

  // Heartbeat is active if streaming or has background tasks
  return heartbeat.isStreaming || heartbeat.activeBackgroundTasks > 0;
}

/**
 * Get a human-readable description of the active heartbeat.
 * Useful for warning messages.
 *
 * @param heartbeat - Active heartbeat data
 * @returns Description of what the other instance is doing
 */
export function describeHeartbeatActivity(heartbeat: Heartbeat): string {
  const parts: string[] = [];

  if (heartbeat.isStreaming) {
    parts.push('processing a response');
  }

  if (heartbeat.activeBackgroundTasks > 0) {
    const taskWord = heartbeat.activeBackgroundTasks === 1 ? 'task' : 'tasks';
    parts.push(`running ${heartbeat.activeBackgroundTasks} background ${taskWord}`);
  }

  if (parts.length === 0) {
    return 'active';
  }

  return parts.join(' and ');
}

/**
 * Manager class for heartbeat lifecycle.
 * Handles the periodic update interval and cleanup.
 */
export class HeartbeatManager {
  private intervalId: NodeJS.Timeout | null = null;
  private _activeBackgroundTasks = 0;
  private _isStreaming = false;

  constructor(
    private sessionDir: string,
    private instanceId: string
  ) {}

  /**
   * Number of active background tasks.
   */
  get activeBackgroundTasks(): number {
    return this._activeBackgroundTasks;
  }

  /**
   * Whether a response is currently streaming.
   */
  get isStreaming(): boolean {
    return this._isStreaming;
  }

  /**
   * Whether the heartbeat is currently active (updating periodically).
   */
  get isActive(): boolean {
    return this.intervalId !== null;
  }

  /**
   * Set streaming state. Starts heartbeat if becoming active.
   */
  setStreaming(streaming: boolean): void {
    this._isStreaming = streaming;
    this.updateActivityState();
  }

  /**
   * Set background task count. Starts/stops heartbeat as needed.
   */
  setBackgroundTaskCount(count: number): void {
    this._activeBackgroundTasks = count;
    this.updateActivityState();
  }

  /**
   * Increment background task count.
   */
  incrementBackgroundTasks(): void {
    this._activeBackgroundTasks++;
    this.updateActivityState();
  }

  /**
   * Decrement background task count.
   */
  decrementBackgroundTasks(): void {
    this._activeBackgroundTasks = Math.max(0, this._activeBackgroundTasks - 1);
    this.updateActivityState();
  }

  /**
   * Check if another instance is actively using this session.
   */
  checkForConflict(): { hasConflict: boolean; description?: string } {
    const heartbeat = readHeartbeat(this.sessionDir);

    if (isHeartbeatActive(heartbeat, this.instanceId)) {
      return {
        hasConflict: true,
        description: describeHeartbeatActivity(heartbeat!),
      };
    }

    return { hasConflict: false };
  }

  /**
   * Stop heartbeat and cleanup.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    clearHeartbeat(this.sessionDir);
  }

  /**
   * Update heartbeat state based on activity.
   * Starts interval if becoming active, stops if becoming idle.
   */
  private updateActivityState(): void {
    const shouldBeActive = this._isStreaming || this._activeBackgroundTasks > 0;

    if (shouldBeActive && !this.intervalId) {
      // Start heartbeat
      this.writeHeartbeatNow();
      this.intervalId = setInterval(() => {
        this.writeHeartbeatNow();
      }, HEARTBEAT_UPDATE_INTERVAL_MS);
    } else if (!shouldBeActive && this.intervalId) {
      // Stop heartbeat
      clearInterval(this.intervalId);
      this.intervalId = null;
      clearHeartbeat(this.sessionDir);
    } else if (shouldBeActive) {
      // Already active, just update
      this.writeHeartbeatNow();
    }
  }

  private writeHeartbeatNow(): void {
    writeHeartbeat(
      this.sessionDir,
      this.instanceId,
      this._activeBackgroundTasks,
      this._isStreaming
    );
  }
}
