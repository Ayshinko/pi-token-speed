import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TokenSpeedEngine } from "../src/core/engine";
import { Renderer } from "../src/ui/renderer";
import {
  parseCompletedRequest,
  parseLiveMetrics,
  StrataMetricsPoller,
} from "../src/native/strata-metrics";
import { OverrideValidator } from "../src/settings/items/override-validator";
import { settings } from "../src/config/settings";
import type {
  NativeMetricsConfig,
  TokenSpeedConfig,
} from "../src/config/types";

// ---------- payload fixtures (shape verified against Strata /metrics) ----------

const livePayload = (over: Record<string, unknown> = {}) => ({
  engine: "0.1.39",
  model: "qwen3.8-flash-next-q2_0",
  live: {
    state: "generating",
    queued: 0,
    phase: "decode",
    prompt_tokens: 512,
    prompt_read: 512,
    prompt_total: 512,
    generated: 340,
    max_tokens: 2048,
    elapsed_s: 5.1,
    tok_s: 68.4,
    tok_s_mean: 64.9,
    prefill_tok_s_mean: 1180,
    tok_s_window_s: 2,
    ...over,
  },
  requests: [],
});

const completedPayload = (times: number[]) => ({
  live: { state: "idle", generated: 0 },
  requests: times.map((time) => ({
    projection: "qwen3.8-flash-next-q2_0",
    time,
    duration_s: 20.4,
    finish: "stop",
    prompt_tokens: 512,
    output_tokens: 1248,
    decode_ms: 19300,
    decode_tok_s: 64.7,
  })),
});

/** A single finished-request record with per-request values, newest-first. */
const finishedRecord = (
  time: number,
  outputTokens: number,
  decodeTokS: number,
  decodeMs: number,
) => ({
  projection: "qwen3.8-flash-next-q2_0",
  time,
  duration_s: 20.4,
  finish: "stop",
  prompt_tokens: 512,
  output_tokens: outputTokens,
  decode_ms: decodeMs,
  decode_tok_s: decodeTokS,
});

// ---------- parsing ----------

describe("parseLiveMetrics", () => {
  it("reads a generating snapshot", () => {
    const snap = parseLiveMetrics(livePayload());
    expect(snap).toEqual({
      liveTps: 68.4,
      meanTps: 64.9,
      prefillTps: 1180,
      outputTokens: 340,
      decodeSeconds: 5.1,
      completed: false,
    });
  });

  it("accepts the prompt-reading phase", () => {
    const snap = parseLiveMetrics(livePayload({ state: "reading" }));
    expect(snap?.liveTps).toBe(68.4);
  });

  it("returns null when the engine is idle", () => {
    expect(parseLiveMetrics(livePayload({ state: "idle" }))).toBeNull();
    expect(parseLiveMetrics(livePayload({ state: "unloaded" }))).toBeNull();
  });

  it("returns null for malformed payloads", () => {
    expect(parseLiveMetrics(null)).toBeNull();
    expect(parseLiveMetrics("not json")).toBeNull();
    expect(parseLiveMetrics({})).toBeNull();
    expect(parseLiveMetrics({ live: null })).toBeNull();
    expect(parseLiveMetrics({ live: 42 })).toBeNull();
  });

  it("treats missing or non-finite numbers as zero", () => {
    const snap = parseLiveMetrics({
      live: { state: "generating", tok_s: null, tok_s_mean: NaN },
    });
    expect(snap?.liveTps).toBe(0);
    expect(snap?.meanTps).toBe(0);
  });
});

describe("parseCompletedRequest", () => {
  it("uses the newest finished request", () => {
    const snap = parseCompletedRequest(completedPayload([1000, 900, 800]));
    expect(snap).toEqual({
      liveTps: 64.7,
      meanTps: 64.7,
      prefillTps: 0,
      outputTokens: 1248,
      decodeSeconds: 19.3,
      completed: true,
    });
  });

  it("ignores requests from before the current stream", () => {
    expect(
      parseCompletedRequest(completedPayload([1000, 900]), 1000),
    ).toBeNull();
    expect(
      parseCompletedRequest(completedPayload([1000, 1500]), 1000)?.outputTokens,
    ).toBe(1248);
  });

  it("falls back to duration_s when decode_ms is missing", () => {
    const payload = {
      requests: [
        { time: 10, output_tokens: 100, decode_tok_s: 50, duration_s: 2.5 },
      ],
    };
    expect(parseCompletedRequest(payload)?.decodeSeconds).toBe(2.5);
  });

  it("skips records with no output or no rate", () => {
    expect(
      parseCompletedRequest({
        requests: [{ time: 10, output_tokens: 0, decode_tok_s: 0 }],
      }),
    ).toBeNull();
    expect(parseCompletedRequest({ requests: [] })).toBeNull();
    expect(parseCompletedRequest({ requests: null })).toBeNull();
  });
});

// ---------- poller ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stubFetch(payload: unknown, delayMs = 0) {
  vi.stubGlobal(
    "fetch",
    async (_url: string, opts?: { signal?: AbortSignal }) => {
      if (delayMs) await sleep(delayMs);
      if (opts?.signal?.aborted) throw new Error("aborted");
      return { ok: true, json: async () => payload };
    },
  );
}

describe("StrataMetricsPoller", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("polls and exposes a live snapshot", async () => {
    stubFetch(livePayload());
    const poller = new StrataMetricsPoller({
      url: "http://127.0.0.1:8080/metrics",
      intervalMs: 50,
    });
    poller.start();
    await sleep(120);
    poller.stop();
    expect(poller.current?.liveTps).toBe(68.4);
    expect(poller.current?.completed).toBe(true);
  });

  it("stays null when the endpoint is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connection refused");
    });
    const poller = new StrataMetricsPoller({
      url: "http://127.0.0.1:8080/metrics",
      intervalMs: 50,
    });
    poller.start();
    await sleep(120);
    poller.stop();
    expect(poller.current).toBeNull();
  });

  it("stays null when the server returns a non-200 response", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 500 }));
    const poller = new StrataMetricsPoller({
      url: "http://127.0.0.1:8080/metrics",
      intervalMs: 50,
    });
    poller.start();
    await sleep(120);
    poller.stop();
    expect(poller.current).toBeNull();
  });

  it("aborts a hanging request instead of blocking the stream", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const poller = new StrataMetricsPoller({
      url: "http://127.0.0.1:8080/metrics",
      intervalMs: 50,
      timeoutMs: 50,
    });
    poller.start();
    await sleep(150);
    poller.stop();
    expect(poller.current).toBeNull();
  });

  it("latches the prefill rate after the server zeroes it", async () => {
    let phase = 0;
    vi.stubGlobal("fetch", async () => {
      phase += 1;
      const payload =
        phase === 1
          ? livePayload({ prefill_tok_s_mean: 1180 })
          : livePayload({ prefill_tok_s_mean: 0, tok_s: 61.2 });
      return { ok: true, json: async () => payload };
    });

    const poller = new StrataMetricsPoller({
      url: "http://x/metrics",
      intervalMs: 50,
    });
    poller.start();
    await sleep(160);
    poller.stop();
    expect(poller.current?.prefillTps).toBe(1180);
    expect(poller.current?.liveTps).toBe(61.2);
  });

  it("does not leak a previous request into the current snapshot", async () => {
    let phase = 0;
    vi.stubGlobal("fetch", async () => {
      phase += 1;
      const payload =
        phase === 1
          ? completedPayload([1000])
          : {
              ...completedPayload([1000]),
              live: { state: "generating", tok_s: 70, tok_s_mean: 66 },
            };
      return { ok: true, json: async () => payload };
    });

    const poller = new StrataMetricsPoller({
      url: "http://x/metrics",
      intervalMs: 50,
    });
    poller.start();
    await sleep(160);
    expect(poller.current?.completed).toBe(false);
    expect(poller.current?.liveTps).toBe(70);
    poller.stop();
  });

  it("finalize() returns the server's completed record", async () => {
    let phase = 0;
    vi.stubGlobal("fetch", async () => {
      phase += 1;
      const payload =
        phase === 1
          ? completedPayload([1000])
          : { ...completedPayload([1000, 1500]), live: { state: "idle" } };
      return { ok: true, json: async () => payload };
    });

    const poller = new StrataMetricsPoller({
      url: "http://x/metrics",
      intervalMs: 50,
    });
    poller.start();
    await sleep(80);
    const snap = await poller.finalize();
    expect(snap?.completed).toBe(true);
    expect(snap?.meanTps).toBe(64.7);
    expect(snap?.outputTokens).toBe(1248);
  });

  it("finalize() falls back to the last live snapshot on failure", async () => {
    stubFetch(livePayload());
    const poller = new StrataMetricsPoller({
      url: "http://x/metrics",
      intervalMs: 50,
    });
    poller.start();
    await sleep(80);
    vi.stubGlobal("fetch", async () => {
      throw new Error("server went down");
    });
    const snap = await poller.finalize();
    expect(snap?.completed).toBe(true);
    expect(snap?.liveTps).toBe(68.4);
  });

  it("stop() clears the timer so no polling continues", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return { ok: true, json: async () => livePayload() };
    });
    const poller = new StrataMetricsPoller({
      url: "http://x/metrics",
      intervalMs: 20,
    });
    poller.start();
    await sleep(100);
    poller.stop();
    const after = calls;
    await sleep(100);
    expect(calls).toBe(after);
  });

  it("ensureRunning() keeps an armed poller's baseline and snapshot", async () => {
    const payloads = [completedPayload([7]), livePayload()];
    let step = 0;
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => payloads[Math.min(step++, payloads.length - 1)],
    }));
    const poller = new StrataMetricsPoller({
      url: "http://x/metrics",
      intervalMs: 20,
    });
    poller.start();
    await sleep(60);
    expect(
      (poller as unknown as { baselineRequestTime: number })
        .baselineRequestTime,
    ).toBe(7);
    expect(poller.current?.liveTps).toBe(68.4);
    poller.ensureRunning();
    expect(
      (poller as unknown as { baselineRequestTime: number })
        .baselineRequestTime,
    ).toBe(7);
    expect(poller.current?.liveTps).toBe(68.4);
    poller.stop();
  });

  it("Request B never shows Request A's completed record while B is live", async () => {
    const aRec = finishedRecord(100, 1248, 64.7, 19300);
    const bRec = finishedRecord(200, 888, 80.0, 11100);
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
      {
        ...livePayload({ tok_s: 71.2, tok_s_mean: 66.0, prefill_tok_s_mean: 0 }),
        requests: [aRec], // A's completed record still present while B is live
      },
      { live: { state: "idle" }, requests: [bRec, aRec] }, // B completes
    ];
    let step = 0;
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => payloads[Math.min(step++, payloads.length - 1)],
    }));

    const poller = new StrataMetricsPoller({
      url: "http://x/metrics",
      intervalMs: 300,
    });
    poller.start();
    await sleep(340); // A reading + A generating
    expect(poller.current?.liveTps).toBe(55.0);
    await sleep(320); // A completed (live idle: snapshot unchanged)
    expect(poller.current?.completed).toBe(false);

    poller.beginNativeRequest(); // Request B begins
    expect(poller.current).toBeNull(); // previous request state dropped
    await sleep(330); // B live poll while A's record is still in requests

    // B's live metrics win; A's completed record must not replace them.
    expect(poller.current?.completed).toBe(false);
    expect(poller.current?.liveTps).toBe(71.2);
    expect(poller.current?.meanTps).toBe(66.0);
    expect(poller.current?.prefillTps).not.toBe(1500);

    const snap = await poller.finalize(); // bounded fetch sees B's record
    expect(snap?.completed).toBe(true);
    expect(snap?.meanTps).toBe(80.0);
    expect(snap?.outputTokens).toBe(888);
    expect(snap?.outputTokens).not.toBe(1248); // never A's record
  });

  it("Request B never inherits Request A's latched prefill rate", async () => {
    const aRec = finishedRecord(100, 1248, 64.7, 19300);
    const payloads = [
      livePayload({
        state: "reading",
        tok_s: 0,
        tok_s_mean: 0,
        prefill_tok_s_mean: 6666,
        generated: 0,
      }),
      livePayload({ tok_s: 55.0, tok_s_mean: 52.0, prefill_tok_s_mean: 0 }),
      {
        ...livePayload({
          state: "reading",
          tok_s: 0,
          tok_s_mean: 0,
          prefill_tok_s_mean: 900,
          generated: 0,
        }),
        requests: [aRec],
      },
      livePayload({ tok_s: 71.2, tok_s_mean: 66.0, prefill_tok_s_mean: 0 }),
    ];
    let step = 0;
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => payloads[Math.min(step++, payloads.length - 1)],
    }));

    const poller = new StrataMetricsPoller({
      url: "http://x/metrics",
      intervalMs: 300,
    });
    poller.start();
    await sleep(340); // A reading + A generating: A's PP latched
    expect(poller.current?.prefillTps).toBe(6666);
    expect(
      (poller as unknown as { latchedPrefill: number }).latchedPrefill,
    ).toBe(6666);

    poller.beginNativeRequest();
    expect(poller.current).toBeNull();
    // The latch itself is destroyed, not merely hidden.
    expect(
      (poller as unknown as { latchedPrefill: number }).latchedPrefill,
    ).toBe(0);

    await sleep(330); // B reading with its own prefill rate
    expect(poller.current?.prefillTps).toBe(900);
    await sleep(320); // B generating: B's own latch sticks (never A's 6666)
    expect(poller.current?.prefillTps).toBe(900);
    expect(poller.current?.liveTps).toBe(71.2);
    poller.stop();
  });

  it("tracks three sequential provider requests and finalizes the last one", async () => {
    const aRec = finishedRecord(100, 1248, 64.7, 19300);
    const bRec = finishedRecord(200, 888, 80.0, 11100);
    const cRec = finishedRecord(300, 555, 91.3, 6081);
    const payloads = [
      livePayload({ tok_s: 55.0, tok_s_mean: 52.0, prefill_tok_s_mean: 0 }),
      { live: { state: "idle" }, requests: [aRec] },
      {
        ...livePayload({ tok_s: 71.2, tok_s_mean: 66.0, prefill_tok_s_mean: 0 }),
        requests: [aRec],
      },
      { live: { state: "idle" }, requests: [bRec, aRec] },
      {
        ...livePayload({ tok_s: 88.4, tok_s_mean: 84.0, prefill_tok_s_mean: 0 }),
        requests: [bRec, aRec],
      },
      { live: { state: "idle" }, requests: [cRec, bRec, aRec] },
    ];
    let step = 0;
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => payloads[Math.min(step++, payloads.length - 1)],
    }));

    const poller = new StrataMetricsPoller({
      url: "http://x/metrics",
      intervalMs: 300,
    });
    poller.start();
    await sleep(340); // Request A: live then completed
    poller.beginNativeRequest(); // Request B begins
    await sleep(330); // B live while A's record is still present
    expect(poller.current?.liveTps).toBe(71.2);
    expect(poller.current?.completed).toBe(false);

    poller.beginNativeRequest(); // Request C begins
    await sleep(600); // B completed (idle) then C live with A/B records present
    expect(poller.current?.liveTps).toBe(88.4);
    expect(poller.current?.meanTps).toBe(84.0);

    const snap = await poller.finalize(); // must finalize the LAST request
    expect(snap?.outputTokens).toBe(555);
    expect(snap?.meanTps).toBe(91.3);
    expect(snap?.outputTokens).not.toBe(1248); // not A
    expect(snap?.outputTokens).not.toBe(888); // not B
  });
});

// ---------- engine integration ----------

describe("TokenSpeedEngine native metrics integration", () => {
  afterEach(() => vi.unstubAllGlobals());

  const engineWith = (
    nativeMetrics?: TokenSpeedConfig["nativeMetrics"],
  ): TokenSpeedEngine => {
    const engine = new TokenSpeedEngine();
    const apply = engine as unknown as {
      applyConfig: (config: TokenSpeedConfig) => void;
    };
    apply.applyConfig({
      display: "tps",
      slidingWindow: 5000,
      useProviderTokens: false,
      countStrategy: "direct",
      endTpsBehavior: "average",
      icon: "⚡",
      updateInterval: 0,
      formatDuration: false,
      thresholds: { slow: 10, medium: 30, fast: 60, blazing: 100 },
      colors: {
        slow: "#ffcc00",
        medium: "#88cc00",
        fast: "#44cc44",
        blazing: "#00ccff",
      },
      displayColors: { count: "", elapsed: "", ttft: "" },
      providerOverrides: {},
      nativeMetrics,
    });
    return engine;
  };

  it("has no native adapter by default", () => {
    const engine = engineWith();
    expect(engine.hasNativeMetrics).toBe(false);
    expect(engine.nativeSnapshot).toBeNull();
  });

  it("exposes a snapshot once the poller has data", async () => {
    stubFetch(livePayload());
    const engine = engineWith({ url: "http://x/metrics", intervalMs: 50 });
    expect(engine.hasNativeMetrics).toBe(true);
    engine.start();
    await sleep(120);
    expect(engine.nativeSnapshot?.liveTps).toBe(68.4);
    engine.stop();
    expect(engine.nativeSnapshot?.completed).toBe(true);
  });

  it("finalizeNativeMetrics is a no-op without an adapter", async () => {
    const engine = engineWith();
    await engine.finalizeNativeMetrics();
    expect(engine.nativeSnapshot).toBeNull();
  });

  it("startNativeMetrics() observes the prefill phase before the stream starts", async () => {
    stubFetch(livePayload({ state: "reading", prefill_tok_s_mean: 2720 }));
    const engine = engineWith({ url: "http://x/metrics", intervalMs: 30 });
    engine.startNativeMetrics();
    await sleep(80);
    expect(engine.nativeSnapshot?.prefillTps).toBe(2720);
    expect(engine.nativeSnapshot?.completed).toBe(false);
    engine.stop();
  });

  it("stream start does not reset the armed adapter or its latched prefill", async () => {
    let phase: "reading" | "generating" = "reading";
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () =>
        livePayload({
          state: phase,
          prefill_tok_s_mean: phase === "reading" ? 2720 : 0,
        }),
    }));
    const engine = engineWith({ url: "http://x/metrics", intervalMs: 20 });
    engine.startNativeMetrics();
    await sleep(60);
    expect(engine.nativeSnapshot?.prefillTps).toBe(2720);
    phase = "generating"; // Strata zeroes prefill once decoding starts
    engine.start(); // assistant stream begins
    await sleep(60);
    expect(engine.nativeSnapshot?.prefillTps).toBe(2720); // still latched
    expect(engine.nativeSnapshot?.liveTps).toBe(68.4);
    engine.stop();
  });

  it("recognizes a short request that completes before the first assistant poll", async () => {
    // The first poll (at user-message start) already sees the finished
    // request, so the baseline is taken too late and would hide its record.
    const payload = completedPayload([200, 100]);
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => payload,
    }));
    const engine = engineWith({ url: "http://x/metrics", intervalMs: 30 });
    engine.startNativeMetrics();
    await sleep(50);
    engine.start(); // must not disturb the baseline
    await engine.finalizeNativeMetrics();
    expect(engine.nativeSnapshot?.completed).toBe(true);
    expect(engine.nativeSnapshot?.outputTokens).toBe(1248);
  });

  it("does not leak a previous request into the final snapshot", async () => {
    const prevPayload = {
      requests: [
        { time: 100, output_tokens: 999, decode_tok_s: 10, decode_ms: 10000 },
      ],
    };
    const currentPayload = {
      requests: [
        {
          time: 200,
          output_tokens: 1248,
          decode_tok_s: 64.7,
          decode_ms: 19300,
        },
        { time: 100, output_tokens: 999, decode_tok_s: 10, decode_ms: 10000 },
      ],
    };
    const payloads = [prevPayload, livePayload(), currentPayload];
    let step = 0;
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => payloads[Math.min(step++, payloads.length - 1)],
    }));
    const engine = engineWith({ url: "http://x/metrics", intervalMs: 20 });
    engine.startNativeMetrics();
    await sleep(80);
    await engine.finalizeNativeMetrics();
    expect(engine.nativeSnapshot?.completed).toBe(true);
    expect(engine.nativeSnapshot?.outputTokens).toBe(1248);
  });

  it("never polls for providers without nativeMetrics", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return { ok: true, json: async () => livePayload() };
    });
    const engine = engineWith();
    engine.startNativeMetrics();
    engine.start();
    await sleep(60);
    expect(calls).toBe(0);
  });

  it("beginNativeRequest is a no-op without an adapter", () => {
    const engine = engineWith();
    expect(() => engine.beginNativeRequest()).not.toThrow();
    expect(engine.nativeSnapshot).toBeNull();
  });

  it("beginNativeRequest resets native request state but never the task timer", async () => {
    stubFetch(livePayload());
    const engine = engineWith({ url: "http://x/metrics", intervalMs: 60 });
    engine.startTask();
    engine.startNativeMetrics();
    await sleep(90); // a live poll applied
    expect(engine.nativeSnapshot?.liveTps).toBe(68.4);

    // A retry / continuation begins a new provider request: per-request state
    // resets, but Total keeps growing from the original submission.
    engine.beginNativeRequest();
    expect(engine.nativeSnapshot).toBeNull();
    const before = engine.taskElapsedSeconds;
    await sleep(70);
    expect(engine.taskElapsedSeconds).toBeGreaterThan(before);

    engine.finishTask();
    const frozen = engine.taskElapsedSeconds;
    await sleep(30);
    expect(engine.taskElapsedSeconds).toBe(frozen);
    engine.stop();
  });

  it("a short request that completes before the first live poll resolves to the right request", async () => {
    const aRec = finishedRecord(100, 1248, 64.7, 19300);
    const bRec = finishedRecord(200, 888, 80.0, 11100);
    const payload = { live: { state: "idle" }, requests: [bRec, aRec] };
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => payload,
    }));
    const engine = engineWith({ url: "http://x/metrics", intervalMs: 40 });
    engine.startNativeMetrics(); // task start
    engine.beginNativeRequest(); // request B begins (already finished server-side)
    await engine.finalizeNativeMetrics();
    expect(engine.nativeSnapshot?.completed).toBe(true);
    expect(engine.nativeSnapshot?.outputTokens).toBe(888);
    expect(engine.nativeSnapshot?.meanTps).toBe(80.0);
    expect(engine.nativeSnapshot?.outputTokens).not.toBe(1248); // never A
  });
});

// ---------- renderer ----------

const nativeConfig: TokenSpeedConfig = {
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
};

describe("Renderer native path", () => {
  const makeRenderer = (
    snapshot: unknown,
    config: TokenSpeedConfig = nativeConfig,
  ) => {
    const engine = new TokenSpeedEngine();
    Object.assign(engine, { _native: { current: snapshot } });
    vi.spyOn(settings, "getEffectiveConfig").mockReturnValue(config);
    const renderer = new Renderer(engine);
    const setStatus = vi.fn();
    const ctx = {
      ui: {
        setStatus,
        theme: { fg: (_c: string, t: string) => t } as any,
      },
      model: { provider: "strata" },
    } as unknown as ExtensionContext;
    return { renderer, setStatus, ctx };
  };

  it("renders the compact live native format", () => {
    const { renderer, setStatus, ctx } = makeRenderer({
      liveTps: 68.4,
      meanTps: 64.9,
      prefillTps: 1180,
      outputTokens: 340,
      decodeSeconds: 5.1,
      completed: false,
    });
    renderer.update(ctx);
    expect(setStatus.mock.calls[0][1]).toBe(
      "⚡ 68.4 tok/s · Mean 64.9 · PP 1180 tok/s​",
    );
  });

  it("renders the completed native format", () => {
    const { renderer, setStatus, ctx } = makeRenderer({
      liveTps: 64.7,
      meanTps: 64.7,
      prefillTps: 0,
      outputTokens: 1248,
      decodeSeconds: 19.3,
      completed: true,
    });
    renderer.update(ctx);
    expect(setStatus.mock.calls[0][1]).toBe(
      "⚡ Mean 64.7 tok/s · 1248 tok · Gen 19.3s​",
    );
  });

  it("falls back to the counter when no snapshot exists", () => {
    const { renderer, setStatus, ctx } = makeRenderer(null);
    renderer.update(ctx);
    expect(setStatus.mock.calls[0][1]).toContain("TPS:");
  });

  it("keeps the display-mode suffix in native mode", () => {
    const { renderer, setStatus, ctx } = makeRenderer(
      {
        liveTps: 68.4,
        meanTps: 64.9,
        prefillTps: 0,
        outputTokens: 340,
        decodeSeconds: 5.1,
        completed: false,
      },
      { ...nativeConfig, display: "stats" },
    );
    renderer.update(ctx);
    expect(setStatus.mock.calls[0][1]).toContain("68.4 tok/s ·");
  });

  it("applies tier colors to the live rate", () => {
    const { renderer, setStatus, ctx } = makeRenderer(
      {
        liveTps: 120,
        meanTps: 110,
        prefillTps: 0,
        outputTokens: 10,
        decodeSeconds: 1,
        completed: false,
      },
      {
        ...nativeConfig,
        colors: {
          slow: "#ffcc00",
          medium: "#88cc00",
          fast: "#44cc44",
          blazing: "#00ccff",
        },
      },
    );
    renderer.update(ctx);
    expect(setStatus.mock.calls[0][1]).toContain("\u001b[38;2;0;204;255m120.0");
  });
});

// ---------- override validation ----------

describe("OverrideValidator nativeMetrics", () => {
  const validator = () =>
    new OverrideValidator("strata", settings.getDefaultConfig());

  it("accepts a valid block", () => {
    const { config, errors } = validator().validate({
      nativeMetrics: {
        url: "http://127.0.0.1:8080/metrics",
        intervalMs: 400,
        timeoutMs: 800,
      },
    });
    expect(errors).toHaveLength(0);
    expect(config.nativeMetrics).toEqual({
      url: "http://127.0.0.1:8080/metrics",
      intervalMs: 400,
      timeoutMs: 800,
    });
  });

  it("drops a block with a missing or invalid url", () => {
    const { config } = validator().validate({
      nativeMetrics: { url: "", intervalMs: 300 } as NativeMetricsConfig,
    });
    expect(config.nativeMetrics).toBeUndefined();

    const { config: bad } = validator().validate({
      nativeMetrics: { url: "ftp://127.0.0.1/metrics" },
    });
    expect(bad.nativeMetrics).toBeUndefined();
  });

  it("drops a non-object block", () => {
    const { config } = validator().validate({
      nativeMetrics: "http://x/metrics" as unknown as NativeMetricsConfig,
    });
    expect(config.nativeMetrics).toBeUndefined();
  });

  it("keeps defaults when interval/timeout are out of range", () => {
    const { config, errors } = validator().validate({
      nativeMetrics: { url: "http://x/metrics", intervalMs: 99999 },
    });
    expect(config.nativeMetrics).toEqual({ url: "http://x/metrics" });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("nativeMetrics.intervalMs");
  });
});
