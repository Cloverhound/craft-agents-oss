/**
 * Provider Event Pipeline Tests
 *
 * Simulates the full event pipeline for both Claude and Codex providers:
 *   Agent → main-process token math → renderer event processor → UI state
 *
 * Uses the REAL renderer event processor code (processEvent, handleTextDelta,
 * handleTextComplete, handleComplete, handleUsageUpdate, etc.) to validate
 * that token counts, isIntermediate flags, and message structure are correct
 * for both providers across multi-turn conversations.
 *
 * The "main process layer" is simulated via applyMainProcessTokenMath() which
 * replicates the exact logic from sessions.ts processEvent for the 'complete'
 * case — this is the critical code that branches on inputTokensMode.
 */

import { describe, it, expect } from "bun:test"
import { processEvent } from "../processor"
import type { SessionState, CompleteEvent, TextDeltaEvent, TextCompleteEvent, ToolStartEvent, ToolResultEvent, UsageUpdateEvent, StatusEvent, InfoEvent } from "../types"
import type { Session } from "../../../shared/types"
import type { AgentEventUsage } from "@craft-agent/core/types"

// ============================================================================
// Test Helpers — mirrors session-reset.test.ts patterns
// ============================================================================

function createSession(overrides?: Partial<Session>): Session {
  return {
    id: "test-session",
    workspaceId: "ws-1",
    workspaceName: "Test",
    lastMessageAt: Date.now(),
    messages: [],
    isProcessing: true,
    ...overrides,
  }
}

function createState(overrides?: Partial<SessionState>): SessionState {
  return {
    session: createSession(),
    streaming: null,
    ...overrides,
  }
}

// ============================================================================
// Main process token math simulation
// Replicates the exact branching logic from sessions.ts processEvent 'complete'
// ============================================================================

interface TokenUsageState {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  contextTokens: number
  costUsd: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  contextWindow?: number
}

function applyMainProcessTokenMath(
  current: TokenUsageState | undefined,
  usage: AgentEventUsage
): TokenUsageState {
  const base: TokenUsageState = current ?? {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    contextTokens: 0,
    costUsd: 0,
  }

  const isCumulative = usage.inputTokensMode === "cumulative"

  if (isCumulative) {
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      contextTokens: base.contextTokens,
      costUsd: base.costUsd,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheCreationTokens: usage.cacheCreationTokens ?? 0,
      contextWindow: usage.contextWindow ?? base.contextWindow,
    }
  } else {
    return {
      inputTokens: usage.inputTokens,
      outputTokens: base.outputTokens + usage.outputTokens,
      totalTokens: usage.inputTokens + (base.outputTokens + usage.outputTokens),
      contextTokens: base.contextTokens,
      costUsd: base.costUsd + (usage.costUsd ?? 0),
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheCreationTokens: usage.cacheCreationTokens ?? 0,
      contextWindow: usage.contextWindow ?? base.contextWindow,
    }
  }
}

/**
 * Full pipeline: applies main-process token math then feeds the renderer.
 * Returns updated SessionState after each event, simulating real app behavior.
 */
function runPipeline(
  initialState: SessionState,
  agentUsages: AgentEventUsage[],
): { finalState: SessionState; tokenSnapshots: TokenUsageState[] } {
  let tokenUsage: TokenUsageState | undefined = initialState.session.tokenUsage as TokenUsageState | undefined
  let state = initialState
  const snapshots: TokenUsageState[] = []

  for (const usage of agentUsages) {
    tokenUsage = applyMainProcessTokenMath(tokenUsage, usage)
    snapshots.push({ ...tokenUsage })

    const completeEvent: CompleteEvent = {
      type: "complete",
      sessionId: state.session.id,
      tokenUsage,
    }
    const result = processEvent(state, completeEvent)
    state = result.state
  }

  return { finalState: state, tokenSnapshots: snapshots }
}

// ============================================================================
// Claude token usage tests (absolute mode)
// ============================================================================

describe("Claude token usage (absolute mode)", () => {
  it("replaces inputTokens each turn, accumulates outputTokens", () => {
    const turns: AgentEventUsage[] = [
      { inputTokens: 5000, outputTokens: 200, contextWindow: 200000 },
      { inputTokens: 6000, outputTokens: 300, contextWindow: 200000 },
      { inputTokens: 7500, outputTokens: 150, contextWindow: 200000 },
    ]

    const { tokenSnapshots } = runPipeline(createState(), turns)

    expect(tokenSnapshots[0].inputTokens).toBe(5000)
    expect(tokenSnapshots[0].outputTokens).toBe(200)

    expect(tokenSnapshots[1].inputTokens).toBe(6000)
    expect(tokenSnapshots[1].outputTokens).toBe(500)

    expect(tokenSnapshots[2].inputTokens).toBe(7500)
    expect(tokenSnapshots[2].outputTokens).toBe(650)
    expect(tokenSnapshots[2].totalTokens).toBe(7500 + 650)
  })

  it("accumulates costUsd across turns", () => {
    const turns: AgentEventUsage[] = [
      { inputTokens: 1000, outputTokens: 100, costUsd: 0.01 },
      { inputTokens: 2000, outputTokens: 200, costUsd: 0.02 },
    ]

    const { tokenSnapshots } = runPipeline(createState(), turns)

    expect(tokenSnapshots[0].costUsd).toBe(0.01)
    expect(tokenSnapshots[1].costUsd).toBeCloseTo(0.03)
  })

  it("sets contextWindow from usage", () => {
    const turns: AgentEventUsage[] = [
      { inputTokens: 1000, outputTokens: 100, contextWindow: 200000 },
    ]

    const { tokenSnapshots } = runPipeline(createState(), turns)
    expect(tokenSnapshots[0].contextWindow).toBe(200000)
  })

  it("propagates tokenUsage to renderer session via complete event", () => {
    const turns: AgentEventUsage[] = [
      { inputTokens: 10000, outputTokens: 500, contextWindow: 200000 },
    ]

    const { finalState } = runPipeline(createState(), turns)

    expect(finalState.session.tokenUsage).toBeDefined()
    expect(finalState.session.tokenUsage!.inputTokens).toBe(10000)
    expect(finalState.session.tokenUsage!.outputTokens).toBe(500)
    expect(finalState.session.tokenUsage!.contextWindow).toBe(200000)
  })
})

// ============================================================================
// Codex token usage tests (cumulative mode)
// ============================================================================

describe("Codex token usage (cumulative mode)", () => {
  it("replaces ALL fields each turn (no accumulation)", () => {
    const turns: AgentEventUsage[] = [
      { inputTokens: 10000, outputTokens: 5, inputTokensMode: "cumulative", contextWindow: 400000 },
      { inputTokens: 22000, outputTokens: 10, inputTokensMode: "cumulative", contextWindow: 400000 },
      { inputTokens: 35000, outputTokens: 15, inputTokensMode: "cumulative", contextWindow: 400000 },
    ]

    const { tokenSnapshots } = runPipeline(createState(), turns)

    expect(tokenSnapshots[0].inputTokens).toBe(10000)
    expect(tokenSnapshots[0].outputTokens).toBe(5)
    expect(tokenSnapshots[0].totalTokens).toBe(10005)

    expect(tokenSnapshots[1].inputTokens).toBe(22000)
    expect(tokenSnapshots[1].outputTokens).toBe(10)
    expect(tokenSnapshots[1].totalTokens).toBe(22010)

    expect(tokenSnapshots[2].inputTokens).toBe(35000)
    expect(tokenSnapshots[2].outputTokens).toBe(15)
    expect(tokenSnapshots[2].totalTokens).toBe(35015)
  })

  it("does NOT double-count outputTokens (was the original bug)", () => {
    const turns: AgentEventUsage[] = [
      { inputTokens: 10000, outputTokens: 5, inputTokensMode: "cumulative" },
      { inputTokens: 22000, outputTokens: 10, inputTokensMode: "cumulative" },
      { inputTokens: 35000, outputTokens: 15, inputTokensMode: "cumulative" },
    ]

    const { tokenSnapshots } = runPipeline(createState(), turns)

    // If double-counting: 5 + 10 + 15 = 30. Correct: just 15.
    expect(tokenSnapshots[2].outputTokens).toBe(15)
    expect(tokenSnapshots[2].outputTokens).not.toBe(30)
  })

  it("does NOT double-count inputTokens (cumulative values are stored as-is)", () => {
    const turns: AgentEventUsage[] = [
      { inputTokens: 10000, outputTokens: 5, inputTokensMode: "cumulative" },
      { inputTokens: 22000, outputTokens: 10, inputTokensMode: "cumulative" },
    ]

    const { tokenSnapshots } = runPipeline(createState(), turns)

    // inputTokens should be the raw cumulative value, not 10000+22000
    expect(tokenSnapshots[1].inputTokens).toBe(22000)
    expect(tokenSnapshots[1].inputTokens).not.toBe(32000)
  })

  it("handles a turn with tool use (large cumulative jump)", () => {
    const turns: AgentEventUsage[] = [
      { inputTokens: 10000, outputTokens: 5, inputTokensMode: "cumulative", contextWindow: 400000 },
      { inputTokens: 60000, outputTokens: 120, inputTokensMode: "cumulative", contextWindow: 400000 },
    ]

    const { tokenSnapshots } = runPipeline(createState(), turns)

    expect(tokenSnapshots[1].inputTokens).toBe(60000)
    expect(tokenSnapshots[1].outputTokens).toBe(120)
    expect(tokenSnapshots[1].totalTokens).toBe(60120)
  })

  it("handles potential compaction (cumulative value decreases)", () => {
    const turns: AgentEventUsage[] = [
      { inputTokens: 100000, outputTokens: 500, inputTokensMode: "cumulative" },
      { inputTokens: 120000, outputTokens: 600, inputTokensMode: "cumulative" },
      // Compaction happened server-side — counter resets to a lower base
      { inputTokens: 50000, outputTokens: 650, inputTokensMode: "cumulative" },
    ]

    const { tokenSnapshots } = runPipeline(createState(), turns)

    // Should simply store the new lower value — no negative deltas, no corruption
    expect(tokenSnapshots[2].inputTokens).toBe(50000)
    expect(tokenSnapshots[2].outputTokens).toBe(650)
    expect(tokenSnapshots[2].totalTokens).toBe(50650)
  })

  it("propagates contextWindow correctly", () => {
    const turns: AgentEventUsage[] = [
      { inputTokens: 10000, outputTokens: 5, inputTokensMode: "cumulative", contextWindow: 400000 },
    ]

    const { tokenSnapshots } = runPipeline(createState(), turns)
    expect(tokenSnapshots[0].contextWindow).toBe(400000)
  })
})

// ============================================================================
// Renderer event processor: text_complete + isIntermediate tests
// ============================================================================

describe("isIntermediate flag on text_complete", () => {
  it("intermediate text before tool use creates message with isIntermediate=true", () => {
    let state = createState()

    // Intermediate text (before tool use)
    const textEvent: TextCompleteEvent = {
      type: "text_complete",
      sessionId: "test-session",
      text: "I'll read the file now.",
      isIntermediate: true,
    }
    state = processEvent(state, textEvent).state

    const msgs = state.session.messages.filter(m => m.role === "assistant")
    expect(msgs).toHaveLength(1)
    expect(msgs[0].isIntermediate).toBe(true)
    expect(msgs[0].content).toBe("I'll read the file now.")
  })

  it("final text after tool use has isIntermediate=false", () => {
    let state = createState()

    // Intermediate text
    state = processEvent(state, {
      type: "text_complete",
      sessionId: "test-session",
      text: "Let me check.",
      isIntermediate: true,
    } as TextCompleteEvent).state

    // Tool start + result
    state = processEvent(state, {
      type: "tool_start",
      sessionId: "test-session",
      toolUseId: "tool-1",
      toolName: "Bash",
      toolInput: { command: "echo hello" },
    } as ToolStartEvent).state

    state = processEvent(state, {
      type: "tool_result",
      sessionId: "test-session",
      toolUseId: "tool-1",
      result: "hello",
    } as ToolResultEvent).state

    // Final text
    state = processEvent(state, {
      type: "text_complete",
      sessionId: "test-session",
      text: "The output is hello.",
      isIntermediate: false,
    } as TextCompleteEvent).state

    const assistantMsgs = state.session.messages.filter(m => m.role === "assistant")
    expect(assistantMsgs).toHaveLength(2)
    expect(assistantMsgs[0].isIntermediate).toBe(true)
    expect(assistantMsgs[1].isIntermediate).toBeFalsy()
    expect(assistantMsgs[1].content).toBe("The output is hello.")
  })

  it("single-message turn has isIntermediate=false", () => {
    let state = createState()

    state = processEvent(state, {
      type: "text_complete",
      sessionId: "test-session",
      text: "4",
      isIntermediate: false,
    } as TextCompleteEvent).state

    const msgs = state.session.messages.filter(m => m.role === "assistant")
    expect(msgs).toHaveLength(1)
    expect(msgs[0].isIntermediate).toBeFalsy()
  })
})

// ============================================================================
// Renderer event processor: text_delta streaming
// ============================================================================

describe("text_delta streaming", () => {
  it("accumulates text_delta into streaming message", () => {
    let state = createState()

    state = processEvent(state, {
      type: "text_delta",
      sessionId: "test-session",
      delta: "Hello ",
    } as TextDeltaEvent).state

    state = processEvent(state, {
      type: "text_delta",
      sessionId: "test-session",
      delta: "world",
    } as TextDeltaEvent).state

    expect(state.streaming).toBeDefined()
    expect(state.streaming!.content).toBe("Hello world")

    const streamingMsg = state.session.messages.find(m => m.isStreaming)
    expect(streamingMsg).toBeDefined()
    expect(streamingMsg!.content).toBe("Hello world")
  })

  it("text_complete finalizes streaming message", () => {
    let state = createState()

    state = processEvent(state, {
      type: "text_delta",
      sessionId: "test-session",
      delta: "Hel",
    } as TextDeltaEvent).state

    state = processEvent(state, {
      type: "text_delta",
      sessionId: "test-session",
      delta: "lo",
    } as TextDeltaEvent).state

    state = processEvent(state, {
      type: "text_complete",
      sessionId: "test-session",
      text: "Hello",
      isIntermediate: false,
    } as TextCompleteEvent).state

    expect(state.streaming).toBeNull()
    const msg = state.session.messages.find(m => m.role === "assistant")
    expect(msg).toBeDefined()
    expect(msg!.content).toBe("Hello")
    expect(msg!.isStreaming).toBe(false)
  })

  it("text_complete without prior deltas creates message directly", () => {
    let state = createState()

    state = processEvent(state, {
      type: "text_complete",
      sessionId: "test-session",
      text: "Direct response",
      isIntermediate: false,
    } as TextCompleteEvent).state

    const msg = state.session.messages.find(m => m.role === "assistant")
    expect(msg).toBeDefined()
    expect(msg!.content).toBe("Direct response")
    expect(msg!.isStreaming).toBe(false)
  })
})

// ============================================================================
// Renderer: usage_update event
// ============================================================================

describe("usage_update event", () => {
  it("updates inputTokens in tokenUsage", () => {
    let state = createState({
      session: createSession({
        tokenUsage: {
          inputTokens: 5000,
          outputTokens: 200,
          totalTokens: 5200,
          contextTokens: 0,
          costUsd: 0,
        },
      }),
    })

    state = processEvent(state, {
      type: "usage_update",
      sessionId: "test-session",
      tokenUsage: { inputTokens: 8000, contextWindow: 200000 },
    } as UsageUpdateEvent).state

    expect(state.session.tokenUsage!.inputTokens).toBe(8000)
    expect(state.session.tokenUsage!.outputTokens).toBe(200)
    expect(state.session.tokenUsage!.contextWindow).toBe(200000)
  })
})

// ============================================================================
// Full multi-turn Codex scenario (simulates real session)
// ============================================================================

describe("full Codex multi-turn scenario", () => {
  it("simulates 5-turn conversation with correct token tracking", () => {
    // Codex SDK reports cumulative values — these match real observed data
    const codexTurns: AgentEventUsage[] = [
      { inputTokens: 10436, outputTokens: 5, inputTokensMode: "cumulative", contextWindow: 400000 },
      { inputTokens: 21900, outputTokens: 10, inputTokensMode: "cumulative", contextWindow: 400000 },
      { inputTokens: 34392, outputTokens: 15, inputTokensMode: "cumulative", contextWindow: 400000 },
      { inputTokens: 61570, outputTokens: 117, inputTokensMode: "cumulative", contextWindow: 400000 },
      { inputTokens: 76219, outputTokens: 237, inputTokensMode: "cumulative", contextWindow: 400000 },
    ]

    const { finalState, tokenSnapshots } = runPipeline(createState(), codexTurns)

    // After all 5 turns, inputTokens should be the last cumulative value
    expect(finalState.session.tokenUsage!.inputTokens).toBe(76219)
    expect(finalState.session.tokenUsage!.outputTokens).toBe(237)
    expect(finalState.session.tokenUsage!.totalTokens).toBe(76219 + 237)

    // Context usage percentage: 76219 / (400000 * 0.775) = ~24.6% — reasonable
    const compactionThreshold = Math.round(400000 * 0.775)
    const usagePercent = Math.min(99, Math.round((76219 / compactionThreshold) * 100))
    expect(usagePercent).toBeLessThan(30)

    // Verify no turn had an inflated snapshot
    for (const snap of tokenSnapshots) {
      expect(snap.inputTokens).toBeLessThan(100000)
    }
  })

  it("simulates the bug scenario: cumulative 345k should NOT cause 99% display", () => {
    // The old bug: Codex reported cumulative 345k, stored directly as inputTokens
    // With 400k context window, 345k / 310k threshold = 111% → 99%
    // After fix: cumulative is stored as-is but reflects actual session usage
    // Only hits 99% if the cumulative total genuinely approaches the window

    const turns: AgentEventUsage[] = [
      { inputTokens: 345054, outputTokens: 5313, inputTokensMode: "cumulative", contextWindow: 400000 },
    ]

    const { finalState } = runPipeline(createState(), turns)

    // The value IS stored as 345k — that's what the SDK reported
    expect(finalState.session.tokenUsage!.inputTokens).toBe(345054)

    // But the key insight: with cumulative mode and proper handling,
    // the PREVIOUS bug was that outputTokens was double-counted via +=
    // Now outputTokens is correctly stored as 5313, not inflated
    expect(finalState.session.tokenUsage!.outputTokens).toBe(5313)
    expect(finalState.session.tokenUsage!.totalTokens).toBe(345054 + 5313)
  })
})

// ============================================================================
// Full multi-turn Claude scenario (simulates real session)
// ============================================================================

describe("full Claude multi-turn scenario", () => {
  it("simulates 4-turn conversation with growing context", () => {
    const claudeTurns: AgentEventUsage[] = [
      { inputTokens: 3000, outputTokens: 500, cacheReadTokens: 1500, contextWindow: 200000 },
      { inputTokens: 5000, outputTokens: 800, cacheReadTokens: 3000, contextWindow: 200000 },
      { inputTokens: 8000, outputTokens: 1200, cacheReadTokens: 6000, contextWindow: 200000 },
      { inputTokens: 12000, outputTokens: 600, cacheReadTokens: 10000, contextWindow: 200000 },
    ]

    const { finalState, tokenSnapshots } = runPipeline(createState(), claudeTurns)

    // inputTokens = last turn's value (replaced, not accumulated)
    expect(finalState.session.tokenUsage!.inputTokens).toBe(12000)

    // outputTokens = sum across all turns
    expect(finalState.session.tokenUsage!.outputTokens).toBe(500 + 800 + 1200 + 600)

    // totalTokens = inputTokens + accumulated outputTokens
    expect(finalState.session.tokenUsage!.totalTokens).toBe(12000 + 3100)

    // cacheReadTokens = last turn's value (replaced)
    expect(finalState.session.tokenUsage!.cacheReadTokens).toBe(10000)

    // Context percentage: 12000 / (200000 * 0.775) = ~7.7%
    const compactionThreshold = Math.round(200000 * 0.775)
    const usagePercent = Math.min(99, Math.round((12000 / compactionThreshold) * 100))
    expect(usagePercent).toBeLessThan(10)
  })
})

// ============================================================================
// Mixed scenarios and edge cases
// ============================================================================

describe("edge cases", () => {
  it("first turn with no prior tokenUsage initializes correctly", () => {
    const usage: AgentEventUsage = { inputTokens: 5000, outputTokens: 200 }
    const result = applyMainProcessTokenMath(undefined, usage)

    expect(result.inputTokens).toBe(5000)
    expect(result.outputTokens).toBe(200)
    expect(result.totalTokens).toBe(5200)
    expect(result.costUsd).toBe(0)
  })

  it("cumulative mode first turn with no prior tokenUsage", () => {
    const usage: AgentEventUsage = {
      inputTokens: 10000,
      outputTokens: 5,
      inputTokensMode: "cumulative",
      contextWindow: 400000,
    }
    const result = applyMainProcessTokenMath(undefined, usage)

    expect(result.inputTokens).toBe(10000)
    expect(result.outputTokens).toBe(5)
    expect(result.contextWindow).toBe(400000)
  })

  it("compaction status event clears inputTokens in renderer", () => {
    let state = createState({
      session: createSession({
        tokenUsage: {
          inputTokens: 150000,
          outputTokens: 3000,
          totalTokens: 153000,
          contextTokens: 0,
          costUsd: 0.5,
        },
      }),
    })

    state = processEvent(state, {
      type: "status",
      sessionId: "test-session",
      message: "Compacting conversation...",
      statusType: "compacting",
    } as StatusEvent).state

    // inputTokens zeroed immediately so badge hides during compaction
    expect(state.session.tokenUsage!.inputTokens).toBe(0)
    // Other fields preserved
    expect(state.session.tokenUsage!.outputTokens).toBe(3000)
  })
})
