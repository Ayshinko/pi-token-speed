import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentEndEvent,
  AgentSettledEvent,
  BeforeAgentStartEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TokenSpeedConfig } from "../src/config/types";
import { TokenSpeedEngine } from "../src/core/engine";
import { EventManager } from "../src/core/events";
import { Renderer } from "../src/ui/renderer";
import {
  snapshotsEqual,
  StrataMetricsPoller,
  type NativeMetricsSnapshot,
} from "../src/native/strata-metrics";

const baseConfig: TokenSpeedConfig = {
  display: "tps",
  slidingWindow: 5000,
  useProviderTokens: false,
  countStrategy: "direct",
  endTpsBehavior: "average",
  icon: "⚡",
  updateInterval: 0,
  formatDuration: false,
  thresholds: { slow: 10, medium: 30, fast: 60, blazing: 100 },
  colors: { slow: "", medium: "", fast: "", blazing: "" },
  displayColors: { count: "", elapsed: "", ttft: "" },
  providerOverrides: {},
  nativeMetrics: { url: "http://strata.local/metrics", intervalMs: 20 },
};

vi.mock("../src/config/settings", () => ({
  settings: {
    initialize: async () => {},
    getErrors: () => [],
    getConfig: () => baseConfig,
    getEffectiveConfig: () => baseConfig,
  },
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const livePayload = (over: Record<string, unknown> = {}) => ({
  live: {
    state: "generating",
    tok_s: 68.4,
    tok_s_mean: 64.9,
    prefill_tok_s_mean: 1180,
    generated: 400,
    elapsed_s: 6.1,
    ...over,
  },
  requests: [],
});

const completedPayload = (over: Record<string, unknown> = {}) => ({
  live: { state: "idle" },
  requests: [
    {
      time: 200,
      output_tokens: 1248,
      decode_tok_s: 64.7,
      decode_ms: 36600,
      ...over,
    },
  ],
});

/** Stubbed fetch that serves payloads in order and counts every poll. */
function stubFetch(payloads: Record<string, unknown>[]) {
  const calls = { count: 0 };
  vi.stubGlobal("fetch", async () => {
    const payload = payloads[Math.min(calls.count, payloads.length - 1)];
    calls.count += 1;
    return { ok: true, json: async () => payload };
  });
  return calls;
}

/** Extension context that records every footer text published. */
function makeCtx(provider = "strata-local") {
  const statuses: string[] = [];
  const ctx = {
    model: { provider },
    ui: {
      setStatus: (_key: string, text: string) => {
        statuses.push(text);
      },
      notify: () => {},
      theme: {
        fg: (_token: string, text: string) => text,
        bg: (_token: string, text: string) => text,
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, statuses };
}

const submitEvent = () =>
  ({
    type: "before_agent_start",
    prompt: "hi",
    systemPrompt: "",
    systemPromptOptions: [],
  }) as unknown as BeforeAgentStartEvent;

const settleEvent = () => ({ type: "agent_settled" }) as AgentSettledEvent;

const last = (statuses: string[]) => statuses[statuses.length - 1];

describe("native footer lifecycle", () => {
  afterEach(() => {
    engine.stopNativeMetrics();
    vi.unstubAllGlobals();
  });

  let engine: TokenSpeedEngine;
  let renderer: Renderer;
  let em: EventManager;
  let ctx: ExtensionContext;
  let statuses: string[];

  beforeEach(() => {
    engine = new TokenSpeedEngine();
    renderer = new Renderer(engine);
    em = new EventManager(engine, renderer);
    const made = makeCtx();
    ctx = made.ctx;
    statuses = made.statuses;
  });

  it("redraws the footer during prefill when no text delta arrives", async () => {
    stubFetch([
      livePayload({
        state: "reading",
        tok_s: 0,
        tok_s_mean: 0,
        prefill_tok_s_mean: 2720,
        generated: 0,
        elapsed_s: 0.4,
      }),
    ]);

    await em.handleSessionStart(ctx);
    em.handleBeforeAgentStart(submitEvent(), ctx);
    await sleep(60);

    // Only the placeholder and the native status were published; no
    // message_update was needed to get the footer to change.
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(last(statuses)).toContain("PP 2720");
  });

  it("publishes a changed snapshot and stays silent on identical polls", async () => {
    stubFetch([livePayload()]);

    await em.handleSessionStart(ctx);
    em.handleBeforeAgentStart(submitEvent(), ctx);
    await sleep(100);

    // Placeholder + one native status. Repeated identical polls must not
    // publish the same text again.
    expect(statuses).toHaveLength(2);
    expect(last(statuses)).toContain("68.4 tok/s");
  });

  it("publishes again when a poll changes the rate", async () => {
    const payloads = [
      livePayload({ tok_s: 68.4 }),
      livePayload({ tok_s: 71.2 }),
      livePayload({ tok_s: 71.2 }),
    ];
    stubFetch(payloads);

    await em.handleSessionStart(ctx);
    em.handleBeforeAgentStart(submitEvent(), ctx);
    await sleep(120);

    expect(statuses.some((s) => s.includes("68.4"))).toBe(true);
    expect(statuses.some((s) => s.includes("71.2"))).toBe(true);
    const published = statuses.filter(
      (s) => s.includes("68.4") || s.includes("71.2"),
    );
    expect(published).toHaveLength(2);
  });

  it("keeps polling through agent_end (the task is not over)", async () => {
    const calls = stubFetch([livePayload()]);

    await em.handleSessionStart(ctx);
    em.handleBeforeAgentStart(submitEvent(), ctx);
    await sleep(60);
    const during = calls.count;
    expect(during).toBeGreaterThan(1);

    em.handleAgentEnd({ messages: [] } as unknown as AgentEndEvent, ctx);
    await sleep(60);
    expect(calls.count).toBeGreaterThan(during);
    em.handleSessionShutdown();
  });

  it("stops polling at agent_settled", async () => {
    const calls = stubFetch([livePayload()]);

    await em.handleSessionStart(ctx);
    em.handleBeforeAgentStart(submitEvent(), ctx);
    await sleep(60);
    em.handleAgentEnd({ messages: [] } as unknown as AgentEndEvent, ctx);
    await em.handleAgentSettled(settleEvent(), ctx);
    const after = calls.count;
    await sleep(80);
    expect(calls.count).toBe(after);
  });

  it("renders the completed record with Gen and Total at settle", async () => {
    stubFetch([
      { live: { state: "idle" }, requests: [{ time: 100, output_tokens: 10 }] },
      completedPayload(),
    ]);

    await em.handleSessionStart(ctx);
    em.handleBeforeAgentStart(submitEvent(), ctx);
    await sleep(60);
    await em.handleAgentSettled(settleEvent(), ctx);

    const text = last(statuses);
    expect(text).toContain("Mean 64.7 tok/s");
    expect(text).toContain("1248 tok");
    expect(text).toContain("Gen 36.6s");
    expect(text).toContain("Total");
  });

  it("stops polling at session shutdown", async () => {
    const calls = stubFetch([livePayload()]);

    await em.handleSessionStart(ctx);
    em.handleBeforeAgentStart(submitEvent(), ctx);
    await sleep(60);
    em.handleSessionShutdown();
    const after = calls.count;
    await sleep(80);
    expect(calls.count).toBe(after);
  });

  it("wires the listener into adapters created by a later provider switch", async () => {
    const calls = stubFetch([livePayload()]);
    const seen: (NativeMetricsSnapshot | null)[] = [];

    engine.setNativeUpdateListener((snapshot) => seen.push(snapshot));
    engine.applyProvider("another-provider"); // rebuilds the adapter
    engine.startNativeMetrics();
    await sleep(60);

    expect(calls.count).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.liveTps).toBe(68.4);
    engine.stopNativeMetrics();
  });

  it("uses the latest context for the redraw", async () => {
    stubFetch([livePayload()]);
    const late = makeCtx("anthropic");

    await em.handleSessionStart(ctx);
    em.handleBeforeAgentStart(submitEvent(), ctx);
    // A later event carries a newer context (e.g. model_select); the redraw
    // must publish through that context, not the stale one.
    em.handleMessageUpdate(
      { assistantMessageEvent: { type: "none" } },
      late.ctx,
    );
    engine.startNativeMetrics();
    await sleep(60);

    expect(late.statuses.some((s) => s.includes("68.4"))).toBe(true);
    engine.stopNativeMetrics();
  });

  it("Request A → tool → Request B: B shows B live/PP and never A's completed record", async () => {
    const aRec = {
      time: 100,
      output_tokens: 1248,
      decode_tok_s: 64.7,
      decode_ms: 19300,
    };
    const bRec = {
      time: 200,
      output_tokens: 888,
      decode_tok_s: 80.0,
      decode_ms: 11100,
    };
    const payloads = [
      livePayload({
        state: "reading",
        tok_s: 0,
        tok_s_mean: 0,
        prefill_tok_s_mean: 1500,
        generated: 0,
      }),
      livePayload({ tok_s: 55.0, tok_s_mean: 52.0, prefill_tok_s_mean: 0 }),
      { live: { state: "idle" }, requests: [aRec] }, // A completes
      livePayload({
        state: "reading",
        tok_s: 0,
        tok_s_mean: 0,
        prefill_tok_s_mean: 900,
        generated: 0,
      }), // B reading (A record still present)
      livePayload({
        state: "reading",
        tok_s: 0,
        tok_s_mean: 0,
        prefill_tok_s_mean: 900,
        generated: 0,
      }), // B reading, repeated window
      livePayload({ tok_s: 71.2, tok_s_mean: 66.0, prefill_tok_s_mean: 0 }), // B generating
      { live: { state: "idle" }, requests: [bRec, aRec] }, // B completes
    ];
    stubFetch(payloads);

    await em.handleSessionStart(ctx);
    em.handleBeforeAgentStart(submitEvent(), ctx);
    em.handleBeforeProviderRequest(ctx); // Request A begins
    await sleep(60);

    // Request A live: footer shows A's live TPS / Mean / PP.
    expect(statuses.some((s) => s.includes("PP 1500"))).toBe(true);
    expect(statuses.some((s) => s.includes("55.0 tok/s"))).toBe(true);

    // Stream closes (tool boundary / turn end); the task keeps running and
    // A's completed record stays in /metrics.requests while B runs.
    em.handleAgentEnd({ messages: [] } as unknown as AgentEndEvent, ctx);
    em.handleBeforeProviderRequest(ctx); // Request B begins
    const duringB = statuses.length;
    await sleep(100);

    expect(statuses.slice(duringB).some((s) => s.includes("Mean 64.7"))).toBe(
      false,
    );
    expect(statuses.slice(duringB).some((s) => s.includes("1248 tok"))).toBe(
      false,
    );
    // B runs live: the footer must show B's own reading/generating metrics.
    expect(
      statuses
        .slice(duringB)
        .some((s) => s.includes("PP 900") || s.includes("71.2 tok/s")),
    ).toBe(true);

    await em.handleAgentSettled(settleEvent(), ctx);
    const text = last(statuses);
    expect(text).toContain("Mean 80.0 tok/s"); // completed record is B's
    expect(text).toContain("888 tok");
    expect(text).not.toContain("1248 tok");
  });

  it("Request B reading shows B's prefill, not A's completed snapshot", async () => {
    const aRec = {
      time: 100,
      output_tokens: 1248,
      decode_tok_s: 64.7,
      decode_ms: 19300,
    };
    stubFetch([
      livePayload({ tok_s: 55.0, tok_s_mean: 52.0, prefill_tok_s_mean: 0 }),
      { live: { state: "idle" }, requests: [aRec] }, // A completes
      livePayload({
        state: "reading",
        tok_s: 0,
        tok_s_mean: 0,
        prefill_tok_s_mean: 900,
        generated: 0,
      }), // B reading
    ]);

    await em.handleSessionStart(ctx);
    em.handleBeforeAgentStart(submitEvent(), ctx);
    em.handleBeforeProviderRequest(ctx); // Request A begins
    await sleep(50);
    em.handleBeforeProviderRequest(ctx); // Request B begins
    await sleep(60);

    expect(last(statuses)).toContain("PP 900"); // B's own prefill
    expect(statuses.some((s) => s.includes("Mean 64.7"))).toBe(false);
    expect(statuses.some((s) => s.includes("1248 tok"))).toBe(false);

    await em.handleAgentSettled(settleEvent(), ctx);
  });

  it("agent_settled freezes Total before the final native fetch runs", async () => {
    let slowFinal = false;
    vi.stubGlobal("fetch", async (_url: string, opts?: { signal?: AbortSignal }) => {
      if (slowFinal) await sleep(250);
      if (opts?.signal?.aborted) throw new Error("aborted");
      return { ok: true, json: async () => livePayload() };
    });

    await em.handleSessionStart(ctx);
    em.handleBeforeAgentStart(submitEvent(), ctx);
    await sleep(60);
    const before = engine.taskElapsedSeconds; // free-running Total

    slowFinal = true; // the settle fetch now takes 250ms (timeout range)
    await em.handleAgentSettled(settleEvent(), ctx);

    const frozen = engine.taskElapsedSeconds;
    // The 250ms final fetch must NOT have inflated Total.
    expect(frozen).toBeLessThan(before + 0.12);
    await sleep(80);
    expect(engine.taskElapsedSeconds).toBe(frozen);
  });

  it("a new submitted prompt does not inherit native state from the previous task", async () => {
    const aRec = {
      time: 100,
      output_tokens: 1248,
      decode_tok_s: 64.7,
      decode_ms: 19300,
    };
    stubFetch([livePayload(), { live: { state: "idle" }, requests: [aRec] }]);

    await em.handleSessionStart(ctx);
    em.handleBeforeAgentStart(submitEvent(), ctx);
    em.handleBeforeProviderRequest(ctx); // Request A begins
    await sleep(60);
    expect(engine.nativeSnapshot?.liveTps).toBe(68.4); // A live

    await em.handleAgentEnd({ messages: [] } as unknown as AgentEndEvent, ctx);
    await em.handleAgentSettled(settleEvent(), ctx);
    expect(engine.nativeSnapshot?.completed).toBe(true); // A finalized

    // New prompt in the same session: nothing may leak from the old task.
    em.handleBeforeAgentStart(submitEvent(), ctx);
    expect(engine.nativeSnapshot).toBeNull();
    expect(engine.isTaskFinished).toBe(false);
    em.handleSessionShutdown();
  });

  it("the renderer does not publish identical text twice", () => {
    const made = makeCtx();
    const r = new Renderer(engine);
    r.initialize(made.ctx);
    r.update(made.ctx);
    r.update(made.ctx);
    r.update(made.ctx);
    // Placeholder + one TPS line. Identical repaints are skipped.
    expect(made.statuses).toHaveLength(2);
    expect(made.statuses[0]).toContain("--");
    expect(made.statuses[1]).toContain("0.0 tok/s");
  });
});

describe("snapshotsEqual", () => {
  const snap: NativeMetricsSnapshot = {
    liveTps: 68.4,
    meanTps: 64.9,
    prefillTps: 1180,
    outputTokens: 400,
    decodeSeconds: 6.1,
    completed: false,
  };

  it("treats identical fields as equal", () => {
    expect(snapshotsEqual(snap, { ...snap })).toBe(true);
    expect(snapshotsEqual(null, null)).toBe(true);
  });

  it("detects a change in any field", () => {
    expect(snapshotsEqual(snap, { ...snap, liveTps: 71.2 })).toBe(false);
    expect(snapshotsEqual(snap, { ...snap, outputTokens: 401 })).toBe(false);
    expect(snapshotsEqual(snap, { ...snap, completed: true })).toBe(false);
    expect(snapshotsEqual(snap, null)).toBe(false);
  });

  it("the poller notifies only on meaningful changes", async () => {
    const payloads = [
      livePayload({ tok_s: 68.4 }),
      livePayload({ tok_s: 68.4 }),
      livePayload({ tok_s: 71.2 }),
    ];
    const calls = stubFetch(payloads);
    const seen: (NativeMetricsSnapshot | null)[] = [];

    const poller = new StrataMetricsPoller(
      { url: "http://x/metrics", intervalMs: 15 },
      (s) => seen.push(s),
    );
    poller.start();
    await sleep(100);
    poller.stop();

    expect(calls.count).toBeGreaterThan(2);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.liveTps).toBe(68.4);
    expect(seen[1]?.liveTps).toBe(71.2);
  });
});
