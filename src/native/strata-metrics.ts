/**
 * Optional adapter for Strata's server-native inference metrics.
 *
 * Local inference servers such as Strata (https://github.com/Niko1221/Strata)
 * already know their own throughput: `GET /metrics` reports the live decode
 * rate, the whole-request decode mean, the prompt-processing rate, and the
 * timings of the last finished requests. Using those values avoids the
 * inaccuracies of estimating TPS from client-side stream deltas.
 *
 * The adapter is strictly opt-in (see `providerOverrides.<provider>.nativeMetrics`)
 * and never throws: when the endpoint is unreachable, slow, malformed, or the
 * provider has no adapter configured, `current` stays `null` and the existing
 * engine/renderer path is used unchanged.
 */

import type { NativeMetricsConfig } from "../config/types";

/** Poll cadence and request timeout defaults (ms). */
const DEFAULT_INTERVAL_MS = 300;
const DEFAULT_TIMEOUT_MS = 500;

/**
 * A per-request snapshot of server-native metrics.
 *
 * - `liveTps`: current decode rate reported by the server
 * - `meanTps`: decode mean for the request so far (or for the finished one)
 * - `prefillTps`: prompt-processing rate, latched from the last positive
 *   reading (Strata reports 0 once decoding starts)
 * - `outputTokens`: tokens generated for the request
 * - `decodeSeconds`: decode duration in seconds
 * - `completed`: whether the request has finished
 */
export interface NativeMetricsSnapshot {
  liveTps: number;
  meanTps: number;
  prefillTps: number;
  outputTokens: number;
  decodeSeconds: number;
  completed: boolean;
}

/**
 * Listener invoked when a poll yields a snapshot that differs from the
 * previous one. The footer is delta-driven, so during a quiet prefill or a
 * long tool call no text delta arrives and the renderer never fires; this
 * callback is the hook that requests a TUI redraw on native changes.
 */
export type NativeMetricsUpdateListener = (
  snapshot: NativeMetricsSnapshot,
) => void;

/**
 * Field-by-field snapshot comparison (not object identity): a poll that
 * returns the same numbers must not trigger a redraw.
 */
export function snapshotsEqual(
  a: NativeMetricsSnapshot | null,
  b: NativeMetricsSnapshot | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.liveTps === b.liveTps &&
    a.meanTps === b.meanTps &&
    a.prefillTps === b.prefillTps &&
    a.outputTokens === b.outputTokens &&
    a.decodeSeconds === b.decodeSeconds &&
    a.completed === b.completed
  );
}

/** `true` for finite numbers, `0` otherwise (missing/null/NaN fields). */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Parses the `live` block of a Strata `/metrics` payload.
 *
 * Returns `null` when the payload is malformed or the engine is not busy
 * (state `idle`/`unloaded`), so callers can fall back to the counter.
 */
export function parseLiveMetrics(
  payload: unknown,
): NativeMetricsSnapshot | null {
  if (!payload || typeof payload !== "object") return null;

  const live = (payload as { live?: unknown }).live;
  if (!live || typeof live !== "object") return null;

  const l = live as Record<string, unknown>;
  const state = typeof l.state === "string" ? l.state : "";
  if (state !== "reading" && state !== "generating") return null;

  return {
    liveTps: num(l.tok_s),
    meanTps: num(l.tok_s_mean),
    prefillTps: num(l.prefill_tok_s_mean),
    outputTokens: num(l.generated),
    decodeSeconds: num(l.elapsed_s),
    completed: false,
  };
}

/**
 * Parses the newest finished request from a `/metrics` payload.
 *
 * `requests` is newest-first. Only requests started after `afterTime` are
 * considered, so a snapshot from a previous request never leaks into the
 * current one. Returns `null` when no usable record is present.
 */
export function parseCompletedRequest(
  payload: unknown,
  afterTime = 0,
): NativeMetricsSnapshot | null {
  if (!payload || typeof payload !== "object") return null;

  const requests = (payload as { requests?: unknown }).requests;
  if (!Array.isArray(requests)) return null;

  for (const entry of requests) {
    if (!entry || typeof entry !== "object") continue;

    const r = entry as Record<string, unknown>;
    if (typeof r.time !== "number" || r.time <= afterTime) continue;

    const outputTokens = num(r.output_tokens);
    const decodeTokS = num(r.decode_tok_s);
    if (outputTokens <= 0 || decodeTokS <= 0) continue;

    // `decode_ms` is the decode-only duration; `duration_s` is the whole
    // request (prompt read + decode) and is only used as a fallback.
    const decodeMs = num(r.decode_ms);
    const decodeSeconds = decodeMs > 0 ? decodeMs / 1000 : num(r.duration_s);
    if (decodeSeconds <= 0) continue;

    return {
      liveTps: decodeTokS,
      meanTps: decodeTokS,
      prefillTps: 0,
      outputTokens,
      decodeSeconds,
      completed: true,
    };
  }

  return null;
}

/** Newest finished-request timestamp in the payload (0 when there is none). */
function newestRequestTime(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const requests = (payload as { requests?: unknown }).requests;
  if (!Array.isArray(requests)) return 0;
  return requests.reduce(
    (max, entry) =>
      Math.max(max, num((entry as Record<string, unknown>)?.time)),
    0,
  );
}

/**
 * Lightweight poller for a Strata `/metrics` endpoint.
 *
 * Uses the built-in `fetch` with an AbortController timeout, one in-flight
 * request at a time, and no external dependencies.
 */
export class StrataMetricsPoller {
  private readonly url: string;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private running = false;

  private snapshot: NativeMetricsSnapshot | null = null;
  /** Latched prefill rate: Strata zeroes it once decoding starts. */
  private latchedPrefill = 0;
  /** Timestamp of the newest finished request when the stream started. */
  private baselineRequestTime = 0;
  /** Whether a live `reading`/`generating` reading was ever seen. */
  private sawLive = false;
  /** Change listener wired by the engine once the extension context is known. */
  private onUpdate: NativeMetricsUpdateListener | undefined;

  constructor(
    config: NativeMetricsConfig,
    onUpdate?: NativeMetricsUpdateListener,
  ) {
    this.url = config.url.replace(/\/+$/, "");
    this.intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onUpdate = onUpdate;
  }

  /** Replaces the change listener (set once per session). */
  setOnUpdate(listener: NativeMetricsUpdateListener | undefined): void {
    this.onUpdate = listener;
  }

  /** Latest snapshot, or `null` when native metrics are unavailable. */
  get current(): NativeMetricsSnapshot | null {
    return this.snapshot;
  }

  /** Starts polling for a new request, resetting all per-request state. */
  start(): void {
    this.stop();
    this.snapshot = null;
    this.latchedPrefill = 0;
    this.baselineRequestTime = 0;
    this.sawLive = false;
    this.running = true;
    void this.tick();
  }

  /**
   * Ensures the poller is running without resetting per-request state.
   *
   * The adapter is armed when the user submits a prompt so it can observe the
   * prompt-processing phase and capture a request baseline before the new
   * request finishes. When the assistant stream later starts, the engine
   * calls this instead of `start()` so the already-captured prefill latch
   * and baseline survive.
   */
  ensureRunning(): void {
    if (this.running) return;
    this.start();
  }

  /** Stops polling; marks the last snapshot as completed for the final render. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.controller?.abort();
    this.controller = null;

    if (this.snapshot && !this.snapshot.completed) {
      this.snapshot = { ...this.snapshot, completed: true };
    }
  }

  /**
   * One last bounded fetch at the end of the task (`agent_settled`), so the
   * final status can use the server's own completed-request record. Falls back
   * to the last live snapshot when the endpoint is unavailable.
   */
  async finalize(): Promise<NativeMetricsSnapshot | null> {
    const payload = await this.fetch();
    let completed = parseCompletedRequest(payload, this.baselineRequestTime);

    // A very short request can complete before the first poll, making the
    // baseline the request's own timestamp: its record would then be
    // skipped. That late baseline is detectable when the newest finished
    // request has exactly the baseline timestamp and no live reading was
    // ever observed, so fall back to the newest record (never a previous
    // one, which would have required a live reading to exist).
    if (
      !completed &&
      this.baselineRequestTime > 0 &&
      !this.sawLive &&
      newestRequestTime(payload) === this.baselineRequestTime
    ) {
      completed = parseCompletedRequest(payload, 0);
    }

    if (completed) {
      const changed = !snapshotsEqual(this.snapshot, completed);
      this.snapshot = completed;
      if (changed) this.onUpdate?.(completed);
    }
    this.stop();
    return this.snapshot;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    const payload = await this.fetch();
    if (!this.running) return;

    this.apply(payload);
    this.timer = setTimeout(() => void this.tick(), this.intervalMs);
  }

  private apply(payload: unknown): void {
    if (payload === undefined) return;

    // The first poll sees only previously finished requests: that timestamp
    // is the boundary used to identify the current request later.
    if (this.baselineRequestTime === 0) {
      this.baselineRequestTime = newestRequestTime(payload);
    }

    const live = parseLiveMetrics(payload);
    if (!live) return;
    this.sawLive = true;

    if (live.prefillTps > 0) this.latchedPrefill = live.prefillTps;
    const previous = this.snapshot;
    let next: NativeMetricsSnapshot = {
      ...live,
      prefillTps: this.latchedPrefill,
    };

    // A request can finish before agent_end is delivered; prefer its record.
    const completed = parseCompletedRequest(payload, this.baselineRequestTime);
    if (completed) next = completed;

    this.snapshot = next;
    if (!snapshotsEqual(previous, next)) this.onUpdate?.(next);
  }

  /** Fetches `/metrics`, returning `undefined` on any failure. */
  private async fetch(): Promise<unknown | undefined> {
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return undefined;
      return await response.json();
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = null;
    }
  }
}
