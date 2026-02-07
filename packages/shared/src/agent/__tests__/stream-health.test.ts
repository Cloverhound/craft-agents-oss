/**
 * Tests for stream health watchdog logic.
 *
 * The watchdog detects two failure patterns in the SDK control stream:
 * 1. Death spiral: consecutive "Error in hook callback" + "Stream closed" in stderr
 * 2. Silent stall: no SDK events for STALL_TIMEOUT_MS during active turn
 *
 * These tests verify the detection logic by simulating the stderr callback
 * behavior and stall timer management without needing the full CraftAgent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

// ============================================================
// Extract the death spiral detection logic for isolated testing.
// This mirrors the logic in craft-agent.ts stderr callbacks.
// ============================================================

interface StreamHealthState {
  errorCount: number;
  triggered: boolean;
  stallTimer: ReturnType<typeof setInterval> | null;
  forceStopCalled: boolean;
}

/**
 * Simulates the stderr callback logic from craft-agent.ts.
 * Returns the updated state after processing a stderr line.
 */
function processStderrLine(state: StreamHealthState, data: string): StreamHealthState {
  const isRunnerActive = true; // Simulated — in real code, checks this.sessionRunner

  if (data.includes('Error in hook callback') && data.includes('Stream closed')) {
    state.errorCount++;
    if (state.errorCount >= 3 && isRunnerActive && !state.triggered) {
      state.triggered = true;
      state.forceStopCalled = true;
    }
  } else if (data.includes('Error in hook callback')) {
    // Hook error but not stream-closed — don't reset counter
  } else {
    // Normal stderr output — reset counter
    state.errorCount = 0;
  }

  return state;
}

function createFreshState(): StreamHealthState {
  return {
    errorCount: 0,
    triggered: false,
    stallTimer: null,
    forceStopCalled: false,
  };
}

// ============================================================
// Tests
// ============================================================

describe('Stream Health Watchdog', () => {
  describe('death spiral detection (stderr pattern)', () => {
    it('should not trigger on fewer than 3 consecutive errors', () => {
      const state = createFreshState();

      processStderrLine(state, 'Error in hook callback: Stream closed');
      expect(state.errorCount).toBe(1);
      expect(state.triggered).toBe(false);
      expect(state.forceStopCalled).toBe(false);

      processStderrLine(state, 'Error in hook callback: Stream closed');
      expect(state.errorCount).toBe(2);
      expect(state.triggered).toBe(false);
      expect(state.forceStopCalled).toBe(false);
    });

    it('should trigger on exactly 3 consecutive stream-closed errors', () => {
      const state = createFreshState();

      processStderrLine(state, 'Error in hook callback: Stream closed');
      processStderrLine(state, 'Error in hook callback: Stream closed');
      processStderrLine(state, 'Error in hook callback: Stream closed');

      expect(state.errorCount).toBe(3);
      expect(state.triggered).toBe(true);
      expect(state.forceStopCalled).toBe(true);
    });

    it('should reset error count on normal stderr output', () => {
      const state = createFreshState();

      processStderrLine(state, 'Error in hook callback: Stream closed');
      processStderrLine(state, 'Error in hook callback: Stream closed');
      expect(state.errorCount).toBe(2);

      // Normal stderr output resets the counter
      processStderrLine(state, 'Some normal debug output');
      expect(state.errorCount).toBe(0);
      expect(state.triggered).toBe(false);
    });

    it('should not reset count on non-stream-closed hook errors', () => {
      const state = createFreshState();

      processStderrLine(state, 'Error in hook callback: Stream closed');
      processStderrLine(state, 'Error in hook callback: some other error');
      // Non-stream-closed hook error doesn't reset — might be mid-pattern
      expect(state.errorCount).toBe(1);
      expect(state.triggered).toBe(false);

      processStderrLine(state, 'Error in hook callback: Stream closed');
      expect(state.errorCount).toBe(2);
    });

    it('should only trigger once (guard prevents re-trigger)', () => {
      const state = createFreshState();

      // Trigger the watchdog
      processStderrLine(state, 'Error in hook callback: Stream closed');
      processStderrLine(state, 'Error in hook callback: Stream closed');
      processStderrLine(state, 'Error in hook callback: Stream closed');
      expect(state.forceStopCalled).toBe(true);

      // Reset the flag to track if it fires again
      state.forceStopCalled = false;

      // More errors should NOT trigger again (triggered guard)
      processStderrLine(state, 'Error in hook callback: Stream closed');
      processStderrLine(state, 'Error in hook callback: Stream closed');
      processStderrLine(state, 'Error in hook callback: Stream closed');
      expect(state.forceStopCalled).toBe(false);
    });

    it('should handle realistic stderr output patterns', () => {
      const state = createFreshState();

      // Normal startup stderr
      processStderrLine(state, 'Debugger listening on ws://127.0.0.1:9229');
      processStderrLine(state, 'For help, see: https://nodejs.org/en/docs/inspector');
      expect(state.errorCount).toBe(0);

      // Some warnings during operation
      processStderrLine(state, 'Warning: ExperimentalWarning: Custom ESM Loaders');
      expect(state.errorCount).toBe(0);

      // Death spiral begins
      processStderrLine(state, 'Error in hook callback: BrokenPipeError: Stream closed');
      processStderrLine(state, 'Error in hook callback: BrokenPipeError: Stream closed');
      processStderrLine(state, 'Error in hook callback: BrokenPipeError: Stream closed');
      expect(state.triggered).toBe(true);
    });

    it('should handle interleaved normal output breaking the pattern', () => {
      const state = createFreshState();

      processStderrLine(state, 'Error in hook callback: Stream closed');
      processStderrLine(state, 'Error in hook callback: Stream closed');
      // Interleaved normal output
      processStderrLine(state, '[SDK] Processing tool result');
      expect(state.errorCount).toBe(0);

      // Restart the pattern — needs 3 fresh consecutive errors
      processStderrLine(state, 'Error in hook callback: Stream closed');
      processStderrLine(state, 'Error in hook callback: Stream closed');
      expect(state.triggered).toBe(false);

      processStderrLine(state, 'Error in hook callback: Stream closed');
      expect(state.triggered).toBe(true);
    });
  });

  describe('stall timer management', () => {
    // These tests verify the stall timer logic: paused during tool execution,
    // active when no tools are in-flight.

    it('should track active tool count correctly', () => {
      let activeToolCount = 0;

      // Simulate tool_start events
      activeToolCount++; // tool_start: Bash
      expect(activeToolCount).toBe(1);

      activeToolCount++; // tool_start: Read (parallel)
      expect(activeToolCount).toBe(2);

      // Simulate tool_result events
      activeToolCount = Math.max(0, activeToolCount - 1); // Bash complete
      expect(activeToolCount).toBe(1);

      activeToolCount = Math.max(0, activeToolCount - 1); // Read complete
      expect(activeToolCount).toBe(0);
    });

    it('should not go negative on tool count', () => {
      let activeToolCount = 0;

      // Edge case: tool_result without matching tool_start
      activeToolCount = Math.max(0, activeToolCount - 1);
      expect(activeToolCount).toBe(0);
    });

    it('stall timer should only be active when no tools are in-flight', () => {
      let activeToolCount = 0;
      let stallTimerActive = false;

      const resetStallTimer = () => {
        // Only start the timer when no tools are in-flight
        stallTimerActive = activeToolCount === 0;
      };

      // Initial state — no tools, timer should be active
      resetStallTimer();
      expect(stallTimerActive).toBe(true);

      // Tool starts — timer should be paused
      activeToolCount++;
      stallTimerActive = false; // Simulates clearStreamHealthStallTimer()
      expect(stallTimerActive).toBe(false);

      // Tool completes — timer should restart
      activeToolCount = Math.max(0, activeToolCount - 1);
      resetStallTimer();
      expect(stallTimerActive).toBe(true);
    });

    it('stall timer should stay paused with multiple tools in-flight', () => {
      let activeToolCount = 0;
      let stallTimerActive = true;

      const resetStallTimer = () => {
        stallTimerActive = activeToolCount === 0;
      };

      // Two tools start
      activeToolCount++;
      stallTimerActive = false;
      activeToolCount++;

      // One tool completes — timer should stay paused (one still running)
      activeToolCount = Math.max(0, activeToolCount - 1);
      resetStallTimer();
      expect(stallTimerActive).toBe(false);
      expect(activeToolCount).toBe(1);

      // Last tool completes — timer should restart
      activeToolCount = Math.max(0, activeToolCount - 1);
      resetStallTimer();
      expect(stallTimerActive).toBe(true);
      expect(activeToolCount).toBe(0);
    });

    it('stall timer should pause during compaction and resume after', () => {
      let activeToolCount = 0;
      let isCompacting = false;
      let stallTimerActive = false;

      const resetStallTimer = () => {
        stallTimerActive = activeToolCount === 0 && !isCompacting;
      };

      // Normal state — timer is active
      resetStallTimer();
      expect(stallTimerActive).toBe(true);

      // Compaction starts — timer should pause
      isCompacting = true;
      resetStallTimer();
      expect(stallTimerActive).toBe(false);

      // Compaction finishes — timer should resume
      isCompacting = false;
      resetStallTimer();
      expect(stallTimerActive).toBe(true);
    });

    it('stall timer should stay paused if tools are in-flight during compaction', () => {
      let activeToolCount = 1; // Tool running
      let isCompacting = true; // Also compacting
      let stallTimerActive = false;

      const resetStallTimer = () => {
        stallTimerActive = activeToolCount === 0 && !isCompacting;
      };

      // Both conditions block the timer
      resetStallTimer();
      expect(stallTimerActive).toBe(false);

      // Compaction ends but tool still running
      isCompacting = false;
      resetStallTimer();
      expect(stallTimerActive).toBe(false);

      // Tool also ends — now timer can restart
      activeToolCount = 0;
      resetStallTimer();
      expect(stallTimerActive).toBe(true);
    });
  });

  describe('recovery guard (_isRetry)', () => {
    it('should prevent infinite retry loops', () => {
      // The _isRetry flag prevents auto-recovery from retrying forever.
      // Simulate the logic: only recover if streamHealthTriggered AND !_isRetry
      let recovered = false;

      function shouldRecover(streamHealthTriggered: boolean, _isRetry: boolean): boolean {
        return streamHealthTriggered && !_isRetry;
      }

      // First failure — should recover
      expect(shouldRecover(true, false)).toBe(true);

      // Retry also fails — should NOT recover again
      expect(shouldRecover(true, true)).toBe(false);

      // Normal ForceStopError (not from watchdog) — should not recover
      expect(shouldRecover(false, false)).toBe(false);
    });
  });

  describe('session cleanup on recovery', () => {
    it('should clear session state for fresh start', () => {
      // Simulate the cleanup that happens during auto-recovery
      const sessionState = {
        sessionId: 'old-session-123' as string | null,
        pinnedPreferencesPrompt: 'User likes TypeScript' as string | null,
        preferencesDriftNotified: true,
        onSdkSessionIdClearedCalled: false,
      };

      // Recovery cleanup
      sessionState.sessionId = null;
      sessionState.onSdkSessionIdClearedCalled = true;
      sessionState.pinnedPreferencesPrompt = null;
      sessionState.preferencesDriftNotified = false;

      expect(sessionState.sessionId).toBeNull();
      expect(sessionState.pinnedPreferencesPrompt).toBeNull();
      expect(sessionState.preferencesDriftNotified).toBe(false);
      expect(sessionState.onSdkSessionIdClearedCalled).toBe(true);
    });
  });
});
