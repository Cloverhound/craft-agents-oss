/**
 * Tests for Session Heartbeat utilities
 *
 * Heartbeat provides activity-based detection of concurrent session access
 * across multiple app instances.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getHeartbeatPath,
  writeHeartbeat,
  readHeartbeat,
  clearHeartbeat,
  isHeartbeatActive,
  describeHeartbeatActivity,
  HeartbeatManager,
  HEARTBEAT_UPDATE_INTERVAL_MS,
  type Heartbeat,
} from '../heartbeat.ts';

describe('Heartbeat utilities', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'heartbeat-test-'));
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('getHeartbeatPath', () => {
    it('returns path to heartbeat.json in session dir', () => {
      const path = getHeartbeatPath('/some/session/dir');
      expect(path).toBe('/some/session/dir/heartbeat.json');
    });
  });

  describe('writeHeartbeat', () => {
    it('creates heartbeat file with correct data', () => {
      writeHeartbeat(testDir, 'instance-123', 2, true);

      const path = getHeartbeatPath(testDir);
      expect(existsSync(path)).toBe(true);

      const content = JSON.parse(readFileSync(path, 'utf-8'));
      expect(content.instanceId).toBe('instance-123');
      expect(content.activeBackgroundTasks).toBe(2);
      expect(content.isStreaming).toBe(true);
      expect(typeof content.timestamp).toBe('number');
    });

    it('overwrites existing heartbeat', () => {
      writeHeartbeat(testDir, 'instance-1', 1, true);
      writeHeartbeat(testDir, 'instance-2', 3, false);

      const content = readHeartbeat(testDir);
      expect(content?.instanceId).toBe('instance-2');
      expect(content?.activeBackgroundTasks).toBe(3);
      expect(content?.isStreaming).toBe(false);
    });
  });

  describe('readHeartbeat', () => {
    it('returns null for non-existent file', () => {
      const result = readHeartbeat(testDir);
      expect(result).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      const fs = require('fs');
      fs.writeFileSync(join(testDir, 'heartbeat.json'), 'not json');

      const result = readHeartbeat(testDir);
      expect(result).toBeNull();
    });

    it('returns null for missing required fields', () => {
      const fs = require('fs');
      fs.writeFileSync(
        join(testDir, 'heartbeat.json'),
        JSON.stringify({ instanceId: 'test' }) // Missing timestamp and activeBackgroundTasks
      );

      const result = readHeartbeat(testDir);
      expect(result).toBeNull();
    });

    it('returns valid heartbeat data', () => {
      writeHeartbeat(testDir, 'test-instance', 5, true);

      const result = readHeartbeat(testDir);
      expect(result).not.toBeNull();
      expect(result!.instanceId).toBe('test-instance');
      expect(result!.activeBackgroundTasks).toBe(5);
      expect(result!.isStreaming).toBe(true);
    });
  });

  describe('clearHeartbeat', () => {
    it('removes heartbeat file', () => {
      writeHeartbeat(testDir, 'test', 0, false);
      expect(existsSync(getHeartbeatPath(testDir))).toBe(true);

      clearHeartbeat(testDir);
      expect(existsSync(getHeartbeatPath(testDir))).toBe(false);
    });

    it('handles non-existent file gracefully', () => {
      // Should not throw
      clearHeartbeat(testDir);
    });

    it('cleans up temp file if present', () => {
      const fs = require('fs');
      const tempPath = getHeartbeatPath(testDir) + '.tmp';
      fs.writeFileSync(tempPath, 'temp');

      clearHeartbeat(testDir);
      expect(existsSync(tempPath)).toBe(false);
    });
  });

  describe('isHeartbeatActive', () => {
    it('returns false for null heartbeat', () => {
      expect(isHeartbeatActive(null, 'my-instance')).toBe(false);
    });

    it('returns false for own instance', () => {
      const heartbeat: Heartbeat = {
        instanceId: 'my-instance',
        timestamp: Date.now(),
        activeBackgroundTasks: 5,
        isStreaming: true,
      };
      expect(isHeartbeatActive(heartbeat, 'my-instance')).toBe(false);
    });

    it('returns false for stale heartbeat (>30s old)', () => {
      const heartbeat: Heartbeat = {
        instanceId: 'other-instance',
        timestamp: Date.now() - 35000, // 35 seconds ago
        activeBackgroundTasks: 5,
        isStreaming: true,
      };
      expect(isHeartbeatActive(heartbeat, 'my-instance')).toBe(false);
    });

    it('returns false for idle heartbeat (no streaming, no tasks)', () => {
      const heartbeat: Heartbeat = {
        instanceId: 'other-instance',
        timestamp: Date.now(),
        activeBackgroundTasks: 0,
        isStreaming: false,
      };
      expect(isHeartbeatActive(heartbeat, 'my-instance')).toBe(false);
    });

    it('returns true for fresh heartbeat with streaming', () => {
      const heartbeat: Heartbeat = {
        instanceId: 'other-instance',
        timestamp: Date.now(),
        activeBackgroundTasks: 0,
        isStreaming: true,
      };
      expect(isHeartbeatActive(heartbeat, 'my-instance')).toBe(true);
    });

    it('returns true for fresh heartbeat with background tasks', () => {
      const heartbeat: Heartbeat = {
        instanceId: 'other-instance',
        timestamp: Date.now(),
        activeBackgroundTasks: 3,
        isStreaming: false,
      };
      expect(isHeartbeatActive(heartbeat, 'my-instance')).toBe(true);
    });
  });

  describe('describeHeartbeatActivity', () => {
    it('describes streaming activity', () => {
      const heartbeat: Heartbeat = {
        instanceId: 'test',
        timestamp: Date.now(),
        activeBackgroundTasks: 0,
        isStreaming: true,
      };
      expect(describeHeartbeatActivity(heartbeat)).toBe('processing a response');
    });

    it('describes single background task', () => {
      const heartbeat: Heartbeat = {
        instanceId: 'test',
        timestamp: Date.now(),
        activeBackgroundTasks: 1,
        isStreaming: false,
      };
      expect(describeHeartbeatActivity(heartbeat)).toBe('running 1 background task');
    });

    it('describes multiple background tasks', () => {
      const heartbeat: Heartbeat = {
        instanceId: 'test',
        timestamp: Date.now(),
        activeBackgroundTasks: 3,
        isStreaming: false,
      };
      expect(describeHeartbeatActivity(heartbeat)).toBe('running 3 background tasks');
    });

    it('describes both streaming and background tasks', () => {
      const heartbeat: Heartbeat = {
        instanceId: 'test',
        timestamp: Date.now(),
        activeBackgroundTasks: 2,
        isStreaming: true,
      };
      expect(describeHeartbeatActivity(heartbeat)).toBe(
        'processing a response and running 2 background tasks'
      );
    });

    it('returns "active" for idle state', () => {
      const heartbeat: Heartbeat = {
        instanceId: 'test',
        timestamp: Date.now(),
        activeBackgroundTasks: 0,
        isStreaming: false,
      };
      expect(describeHeartbeatActivity(heartbeat)).toBe('active');
    });
  });
});

describe('HeartbeatManager', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'heartbeat-mgr-test-'));
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('starts with no activity', () => {
      const mgr = new HeartbeatManager(testDir, 'test-instance');
      expect(mgr.isStreaming).toBe(false);
      expect(mgr.activeBackgroundTasks).toBe(0);
      expect(mgr.isActive).toBe(false);
    });
  });

  describe('streaming state', () => {
    it('activates heartbeat when streaming starts', async () => {
      const mgr = new HeartbeatManager(testDir, 'test-instance');
      mgr.setStreaming(true);

      expect(mgr.isStreaming).toBe(true);
      expect(mgr.isActive).toBe(true);

      // Heartbeat file should exist
      await new Promise(r => setTimeout(r, 10)); // Small delay for file write
      const heartbeat = readHeartbeat(testDir);
      expect(heartbeat).not.toBeNull();
      expect(heartbeat!.isStreaming).toBe(true);

      // Cleanup
      mgr.stop();
    });

    it('deactivates heartbeat when streaming stops (and no tasks)', () => {
      const mgr = new HeartbeatManager(testDir, 'test-instance');
      mgr.setStreaming(true);
      mgr.setStreaming(false);

      expect(mgr.isStreaming).toBe(false);
      expect(mgr.isActive).toBe(false);

      // Heartbeat file should be cleared
      const heartbeat = readHeartbeat(testDir);
      expect(heartbeat).toBeNull();
    });
  });

  describe('background task tracking', () => {
    it('activates heartbeat when tasks start', async () => {
      const mgr = new HeartbeatManager(testDir, 'test-instance');
      mgr.incrementBackgroundTasks();

      expect(mgr.activeBackgroundTasks).toBe(1);
      expect(mgr.isActive).toBe(true);

      // Cleanup
      mgr.stop();
    });

    it('increments and decrements correctly', () => {
      const mgr = new HeartbeatManager(testDir, 'test-instance');
      mgr.incrementBackgroundTasks();
      mgr.incrementBackgroundTasks();
      expect(mgr.activeBackgroundTasks).toBe(2);

      mgr.decrementBackgroundTasks();
      expect(mgr.activeBackgroundTasks).toBe(1);

      // Cleanup
      mgr.stop();
    });

    it('does not go below zero', () => {
      const mgr = new HeartbeatManager(testDir, 'test-instance');
      mgr.decrementBackgroundTasks();
      mgr.decrementBackgroundTasks();
      expect(mgr.activeBackgroundTasks).toBe(0);
    });

    it('keeps heartbeat active while tasks running (even if not streaming)', () => {
      const mgr = new HeartbeatManager(testDir, 'test-instance');
      mgr.setStreaming(true);
      mgr.incrementBackgroundTasks();
      mgr.setStreaming(false);

      // Still active because of background task
      expect(mgr.isActive).toBe(true);

      mgr.decrementBackgroundTasks();
      // Now should be inactive
      expect(mgr.isActive).toBe(false);
    });
  });

  describe('conflict detection', () => {
    it('detects no conflict when no other heartbeat', () => {
      const mgr = new HeartbeatManager(testDir, 'my-instance');
      const { hasConflict } = mgr.checkForConflict();
      expect(hasConflict).toBe(false);
    });

    it('detects conflict with active other instance', () => {
      // Write heartbeat from "other instance"
      writeHeartbeat(testDir, 'other-instance', 0, true);

      const mgr = new HeartbeatManager(testDir, 'my-instance');
      const { hasConflict, description } = mgr.checkForConflict();

      expect(hasConflict).toBe(true);
      expect(description).toBe('processing a response');
    });

    it('ignores own heartbeat', () => {
      // Write heartbeat from same instance
      writeHeartbeat(testDir, 'my-instance', 0, true);

      const mgr = new HeartbeatManager(testDir, 'my-instance');
      const { hasConflict } = mgr.checkForConflict();

      expect(hasConflict).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('stop() clears heartbeat and interval', () => {
      const mgr = new HeartbeatManager(testDir, 'test-instance');
      mgr.setStreaming(true);
      expect(mgr.isActive).toBe(true);

      mgr.stop();
      expect(mgr.isActive).toBe(false);

      // Heartbeat file should be gone
      const heartbeat = readHeartbeat(testDir);
      expect(heartbeat).toBeNull();
    });
  });
});
