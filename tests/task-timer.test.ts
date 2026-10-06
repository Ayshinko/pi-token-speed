import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentEndEvent,
  AgentSettledEvent,
  BeforeAgentStartEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TokenSpeedConfig } from "../src/config/types";
import { TokenSpeedEngine } from "../src/core/engine";
import { EventManager } from "../src/core/events";
import { Renderer, formatTaskDuration } from "../src/ui/renderer";

const baseConfig: TokenSpeedConfig = {
  display: "tps",
  slidingWindow: 5000,
  useProviderTokens: false,
  countStrategy: "direct",
  endTpsBehavior: "last",
  icon: "⚡",
  updateInterval: 0,
  formatDuration: false,
  thresholds: { slow: 10, medium: 30, fast: 60, blazing: 100 },
  colors: { slow: "", medium: "", fast: "", blazing: "" },
  displayColors: { count: "", elapsed: "", ttft: "" },
  providerOverrides: {},
};

vi.mock("../src/config/settings", () => ({
  settings: {
    getConfig: () => baseConfig,
    getEffectiveConfig: () => baseConfig,
  },
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- formatTaskDuration ----------

describe("formatTaskDuration", () => {
  it("formats sub-minute durations with one decimal", () => {
    expect(formatTaskDuration(36.6)).toBe("36.6s");
    expect(formatTaskDuration(42.3)).toBe("42.3s");
    expect(formatTaskDuration(0)).toBe("0.0s");
  });

  it("formats minutes compactly", () => {
    expect(formatTaskDuration(72)).toBe("1m12s");
    expect(formatTaskDuration(60)).toBe("1m00s");
    expect(formatTaskDuration(3599)).toBe("59m59s");
  });

  it("formats hours with zero-padded minutes", () => {
    expect(formatTaskDuration(3780)).toBe("1h03m");
    expect(formatTaskDuration(3600)).toBe("1h00m");
    expect(formatTaskDuration(7200)).toBe("2h00m");
  });
});

// ---------- engine-level task timer ----------

describe("TokenSpeedEngine task timer", () => {
  it("startTask begins the timer and elapsed time grows", async () => {
    const engine = new TokenSpeedEngine();
    expect(engine.taskElapsedSeconds).toBe(0);
    engine.startTask();
    expect(engine.taskElapsedSeconds).toBeGreaterThanOrEqual(0);
    await sleep(30);
    expect(engine.taskElapsedSeconds).toBeGreaterThan(0.02);
  });

  it("assistant stream start/stop cycles do not reset the task timer", async () => {
    const engine = new TokenSpeedEngine();
    engine.startTask();
    await sleep(10);
    const before = engine.taskElapsedSeconds;
    engine.start();
    engine.stop();
    engine.start();
    engine.stop();
    await sleep(20);
    expect(engine.taskElapsedSeconds).toBeGreaterThan(before);
  });

  it("tool-call pauses and model turns do not reset the task timer", async () => {
    const engine = new TokenSpeedEngine();
    engine.startTask();
    await sleep(10);
    // First model turn, then a tool call pauses, then another turn.
    engine.start();
    engine.stop();
    engine.pause();
    const mid = engine.taskElapsedSeconds;
    await sleep(20);
    engine.start();
    engine.stop();
    expect(engine.taskElapsedSeconds).toBeGreaterThan(mid);
  });

  it("finishTask freezes the elapsed value", async () => {
    const engine = new TokenSpeedEngine();
    engine.startTask();
    await sleep(20);
    engine.finishTask();
    const frozen = engine.taskElapsedSeconds;
    await sleep(40);
    expect(engine.taskElapsedSeconds).toBe(frozen);
  });

  it("startTask resets a finished task", async () => {
    const engine = new TokenSpeedEngine();
    engine.startTask();
    await sleep(30);
    engine.finishTask();
    const old = engine.taskElapsedSeconds;
    engine.startTask();
    expect(engine.taskElapsedSeconds).toBeLessThan(old);
  });

  it("clearTask resets the timer", () => {
    const engine = new TokenSpeedEngine();
    engine.startTask();
    expect(engine.taskElapsedSeconds).toBeGreaterThanOrEqual(0);
    engine.clearTask();
    expect(engine.taskElapsedSeconds).toBe(0);
  });
});

// ---------- EventManager wiring ----------

describe("EventManager task wiring", () => {
  let engine: TokenSpeedEngine;
  let em: EventManager;

  const ctx = {
    model: { provider: "strata-local" },
    ui: {
      setStatus: () => {},
      theme: {
        fg: (_c: string, t: string) => t,
        bg: (_c: string, t: string) => t,
      },
    },
  } as unknown as ExtensionContext;

  beforeEach(() => {
    engine = new TokenSpeedEngine();
    em = new EventManager(engine, new Renderer(engine));
  });

  const submit = () =>
    em.handleBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "hi",
        systemPrompt: "",
        systemPromptOptions: [],
      } as unknown as BeforeAgentStartEvent,
      ctx,
    );

  const settle = () =>
    em.handleAgentSettled({ type: "agent_settled" } as AgentSettledEvent, ctx);

  it("submitting a prompt starts the task timer", async () => {
    submit();
    await sleep(5);
    expect(engine.taskElapsedSeconds).toBeGreaterThan(0);
    expect(engine.isTaskFinished).toBe(false);
  });

  it("agent_end does not freeze the task timer", async () => {
    submit();
    await sleep(20);
    em.handleAgentEnd({ messages: [] } as unknown as AgentEndEvent, ctx);
    expect(engine.isTaskFinished).toBe(false);
    const growing = engine.taskElapsedSeconds;
    await sleep(20);
    expect(engine.taskElapsedSeconds).toBeGreaterThan(growing);
  });

  it("agent_settled freezes the task timer", async () => {
    submit();
    await sleep(20);
    await settle();
    expect(engine.isTaskFinished).toBe(true);
    const frozen = engine.taskElapsedSeconds;
    await sleep(30);
    expect(engine.taskElapsedSeconds).toBe(frozen);
  });

  it("the timer spans multiple turns, tool calls, and continuations", async () => {
    submit();
    await sleep(20);
    em.handleAgentEnd({ messages: [] } as unknown as AgentEndEvent, ctx);
    await sleep(20);
    em.handleAgentEnd({ messages: [] } as unknown as AgentEndEvent, ctx);
    await sleep(20);
    await settle();
    expect(engine.taskElapsedSeconds).toBeGreaterThanOrEqual(0.05);
  });

  it("a queued steering message does not restart the task timer", async () => {
    submit();
    await sleep(20);
    em.handleAgentEnd({ messages: [] } as unknown as AgentEndEvent, ctx);
    // Queued steering emits message_start with role=user mid-run. There is no
    // message_start task-start handler, so the timer keeps running from the
    // original submission.
    expect(
      (em as unknown as { handleMessageStart?: unknown }).handleMessageStart,
    ).toBeUndefined();
    await sleep(20);
    await settle();
    expect(engine.taskElapsedSeconds).toBeGreaterThanOrEqual(0.04);
  });

  it("agent_settled without a submitted prompt leaves the timer at zero", async () => {
    await settle();
    expect(engine.taskElapsedSeconds).toBe(0);
    expect(engine.isTaskFinished).toBe(false);
  });

  it("the first freeze wins (repeated settle is idempotent)", async () => {
    submit();
    await sleep(20);
    await settle();
    const frozen = engine.taskElapsedSeconds;
    await sleep(20);
    await settle();
    expect(engine.taskElapsedSeconds).toBe(frozen);
  });

  it("a new submitted prompt restarts the task timer", async () => {
    submit();
    await sleep(30);
    await settle();
    const old = engine.taskElapsedSeconds;
    submit();
    expect(engine.taskElapsedSeconds).toBeLessThan(old);
    expect(engine.isTaskFinished).toBe(false);
  });

  it("session shutdown clears the task timer", () => {
    submit();
    expect(engine.taskElapsedSeconds).toBeGreaterThanOrEqual(0);
    em.handleSessionShutdown();
    expect(engine.taskElapsedSeconds).toBe(0);
    expect(engine.isTaskFinished).toBe(false);
  });
});
