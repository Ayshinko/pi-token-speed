import { settings } from "../config/settings";
import type { TokenSpeedConfig } from "../config/types";
import type {
  NativeMetricsSnapshot,
  NativeMetricsUpdateListener,
} from "../native/strata-metrics";
import { StrataMetricsPoller } from "../native/strata-metrics";
import {
  COUNT_STRATEGY_DEFAULT,
  type CountStrategy,
} from "../settings/items/count-strategy";
import {
  END_TPS_BEHAVIOR_DEFAULT,
  type EndTpsBehavior,
} from "../settings/items/end-tps-behavior";
import { SLIDING_WINDOW_DEFAULT } from "../settings/items/sliding-window";
import { USE_PROVIDER_TOKENS_DEFAULT } from "../settings/items/use-provider-tokens";
import { SlidingWindow } from "./sliding-window";

const TOKEN_REGEX = /\w+|[^\s\w]/g;

export class TokenSpeedEngine {
  private _isStreaming = false;
  private _isPaused = false;

  private _tokenCount = 0;
  private _startTime = 0;
  private _endTime = 0;

  private _ttftStart = 0;
  private _ttftEnd = 0;

  private _startPause = 0;
  private _pausedMs = 0;

  private _tps = 0;
  private _countedUsageOutput = 0;

  private _slidingWindow: SlidingWindow;
  private _useProviderTokens = USE_PROVIDER_TOKENS_DEFAULT;
  private _countStrategy: CountStrategy = COUNT_STRATEGY_DEFAULT;
  private _endTpsBehavior: EndTpsBehavior = END_TPS_BEHAVIOR_DEFAULT;
  private _providerId: string | undefined;
  /**
   * Optional server-native metrics adapter (opt-in via
   * `providerOverrides.<provider>.nativeMetrics`). Null when the provider has
   * no adapter configured, which keeps the counter-only path intact.
   */
  private _native: StrataMetricsPoller | null = null;
  /**
   * Listener notified when a poll yields a changed native snapshot. Wired by
   * the event manager so the footer can be redrawn while the stream is quiet
   * (no text deltas → the delta-driven renderer never fires).
   */
  private _nativeListener: NativeMetricsUpdateListener | undefined;
  /**
   * Whole-task wall-clock timer (monotonic, immune to clock changes).
   * `_taskStart` is set when the user submits a prompt (`before_agent_start`);
   * `_taskEnd` freezes the timer when the task settles (`agent_settled`).
   * Distinct from the stream timer, so tool calls, retries, compaction, and
   * queued continuation all count toward Total.
   */
  private _taskStart = 0;
  private _taskEnd = 0;
  /** True once the task timer has been frozen for the current task. */
  private _taskFinished = false;

  constructor() {
    this._slidingWindow = new SlidingWindow(SLIDING_WINDOW_DEFAULT);
  }

  /**
   * Loads configuration.
   * Must be called after `settings.initialize()`.
   */
  initialize(): void {
    this._providerId = undefined;
    this.applyConfig(settings.getConfig());
  }

  /**
   * Re-applies provider-dependent configuration for the given provider.
   *
   * Resolves the effective config (base + provider override block) and
   * refreshes the engine-side fields (slidingWindow, useProviderTokens,
   * countStrategy, endTpsBehavior). A no-op when the provider is unchanged
   * or when a stream is active — mid-stream switches are picked up at the
   * next stream start instead, so the sliding window is never reset while
   * a stream is in flight.
   *
   * @param providerId The pi ProviderId (e.g. "anthropic"), or undefined
   *   when no model is active (base config applies).
   */
  applyProvider(providerId?: string): void {
    if (providerId === this._providerId || this._isStreaming) return;
    this._providerId = providerId;
    this.applyConfig(settings.getEffectiveConfig(providerId));
  }

  /**
   * Applies engine-side fields from a resolved config (fresh sliding
   * window, counting strategy, provider-token usage, end-of-stream
   * behavior). Shared by `initialize` and `applyProvider`.
   */
  private applyConfig(config: TokenSpeedConfig): void {
    this._slidingWindow = new SlidingWindow(config.slidingWindow);
    this._countStrategy = config.countStrategy;
    this._useProviderTokens = config.useProviderTokens;
    this._endTpsBehavior = config.endTpsBehavior;

    // Reconfigure the native metrics adapter (opt-in, per provider).
    this._native?.stop();
    this._native = config.nativeMetrics
      ? new StrataMetricsPoller(config.nativeMetrics, this._nativeListener)
      : null;
  }

  /**
   * Registers the listener notified when a native poll yields a changed
   * snapshot. Applied to the current adapter and to adapters created by later
   * `applyConfig` calls (provider switches), so the redraw wiring survives a
   * mid-session provider change.
   */
  setNativeUpdateListener(listener: NativeMetricsUpdateListener | undefined) {
    this._nativeListener = listener;
    this._native?.setOnUpdate(listener);
  }

  /**
   * Records a streaming delta.
   *
   * Uses provider-reported output-token count when available.
   * Otherwise, falls back to this extension's counter.
   *
   * Counting behavior:
   * - `direct`: Counts 1 token per delta (text, thinking, toolcall)
   * - `estimate`: Approximates tokens from delta text using word-boundary regex
   *
   * @param delta The text/thinking delta string.
   * @param usageOutput Provider-reported cumulative output-token count (optional).
   */
  recordDelta(delta: string, usageOutput?: number): void {
    if (!this._isStreaming) return;
    if (this._isPaused) this.resume();

    const shouldUseProviderTokens =
      this._useProviderTokens &&
      usageOutput !== undefined &&
      usageOutput > this._countedUsageOutput;

    if (shouldUseProviderTokens) {
      this.recordTokens(usageOutput - this._countedUsageOutput);
      this._countedUsageOutput = usageOutput;
      return;
    }

    // Fallback: estimate or direct counting
    if (this._countStrategy === "estimate") {
      this.recordTokens(this.estimateTokens(delta));
    } else {
      this.recordTokens(1);
    }
  }

  /**
   * Snap the total to the authoritative usage so the final average is exact.
   *
   * @param tokens The authoritative token count from the message end event.
   */
  reconcileTotal(tokens: number): void {
    if (tokens > 0) this._tokenCount = tokens;
  }

  /**
   * Whether a streaming session is currently active
   */
  get isStreaming() {
    return this._isStreaming;
  }

  /**
   * Total number of tokens recorded since stream start
   */
  get tokenCount() {
    return this._tokenCount;
  }

  /**
   * Returns elapsed milliseconds since stream start (0 if not started)
   */
  get elapsedMs(): number {
    if (this._startTime === 0) return 0;
    if (this.isStreaming) return Date.now() - this._startTime - this._pausedMs;
    return this._endTime - this._startTime - this._pausedMs;
  }

  /** Returns elapsed seconds since stream start (0 if not started). */
  get elapsedSeconds(): number {
    return this.elapsedMs / 1000;
  }

  /**
   * Returns tokens-per-second based on a time-based sliding window while streaming.
   * When streaming has finished, behavior depends on `endTpsBehavior`:
   * - `"average"` (default): returns the overall average TPS for consistency with stats.
   * - `"last"`: returns the last sliding window measurement.
   */
  get tps(): number {
    if (this._isStreaming) return this._tps;
    if (this._endTpsBehavior === "last") return this._tps;
    return this.tpsAvg;
  }

  /**
   * Returns the overall average tokens-per-second for the entire stream.
   * Computed as total tokens / elapsed seconds. Returns 0 if no time has elapsed.
   */
  get tpsAvg(): number {
    if (this.elapsedSeconds <= 0) return 0;
    return this._tokenCount / this.elapsedSeconds;
  }

  /**
   * Bounded end-of-task fetch (at `agent_settled`) so the final status can
   * use the server's own completed-request record. No-op (and never throws)
   * when no adapter is configured, leaving the counter-based fallback
   * untouched.
   */
  async finalizeNativeMetrics(): Promise<void> {
    if (!this._native) return;
    try {
      await this._native.finalize();
    } catch {
      this._native.stop();
    }
  }

  /**
   * Arms the native metrics adapter for the request that is about to run.
   *
   * Called when the user submits a prompt (`before_agent_start`), i.e. before
   * model inference, so the
   * adapter can observe the server's prompt-processing phase and capture a
   * request baseline before this request finishes. No-op (and never polls)
   * when the active provider has no adapter configured.
   */
  startNativeMetrics(): void {
    this._native?.start();
  }

  /**
   * Server-native metrics snapshot for the current request, or null when the
   * provider has no adapter or the endpoint produced nothing usable.
   */
  get nativeSnapshot(): NativeMetricsSnapshot | null {
    return this._native?.current ?? null;
  }

  /** Whether the active provider has a native metrics adapter configured. */
  get hasNativeMetrics(): boolean {
    return this._native !== null;
  }

  /**
   * Begins timing a new Pi task (reset when the user submits a prompt).
   *
   * Uses `performance.now()` (monotonic) so system clock changes cannot
   * corrupt the measurement. The timer intentionally survives assistant
   * streams, tool calls, and model turns — only a new submitted prompt or
   * session shutdown clears it. Queued steering/follow-up messages do not
   * restart it.
   */
  startTask(): void {
    this._taskStart = performance.now();
    this._taskEnd = 0;
    this._taskFinished = false;
  }

  /**
   * Freezes the task timer. Called at `agent_settled`, the event that marks
   * the end of the whole submitted prompt (retries, compaction, and queued
   * continuation included). Idempotent: the first call wins.
   */
  finishTask(): void {
    if (this._taskStart === 0) return;
    if (this._taskFinished) return;
    this._taskEnd = performance.now();
    this._taskFinished = true;
  }

  /** Clears task timer state (session shutdown). */
  clearTask(): void {
    this._taskStart = 0;
    this._taskEnd = 0;
    this._taskFinished = false;
  }

  /** Whether the task timer is frozen (settled) for the current task. */
  get isTaskFinished(): boolean {
    return this._taskFinished;
  }

  /**
   * Total elapsed seconds of the current Pi task since the prompt was
   * submitted. Continues growing while the task is active; frozen once the
   * task settles; 0 before any submitted prompt.
   */
  get taskElapsedSeconds(): number {
    if (this._taskStart === 0) return 0;
    const end = this._taskEnd > 0 ? this._taskEnd : performance.now();
    return (end - this._taskStart) / 1000;
  }

  /**
   * Returns time to first token in milliseconds
   */
  get ttft(): number {
    return Math.max(this._ttftEnd - this._ttftStart, 0);
  }

  /**
   * Starts a new streaming session.
   */
  start(): void {
    if (this._isStreaming) return;

    this._tokenCount = 0;
    this._isStreaming = true;
    this._startTime = Date.now();
    this._endTime = Date.now();
    this._slidingWindow.reset();
    this._countedUsageOutput = 0;
    this._tps = 0;
    this._pausedMs = 0;

    // The adapter is already armed (at user-message start) so it can
    // observe the prefill phase; starting the stream must not reset it.
    this._native?.ensureRunning();
  }

  /**
   * Records the start timestamp for TTFT measurement.
   */
  startTTFT(): void {
    this._ttftStart = Date.now();
    this._ttftEnd = 0;
  }

  /**
   * Records the end timestamp for TTFT measurement.
   * Only captures once per stream (guarded by _ttftEnd).
   */
  stopTTFT(): void {
    if (this._ttftEnd !== 0) return;
    this._ttftEnd = Date.now();
  }

  /**
   * Stops the stream counter only. Used at `agent_end`, which closes one
   * assistant stream: the task is not over (queued continuation, tool calls,
   * compaction, retries can follow), so the native poller keeps running
   * until the task settles.
   */
  stopStreaming(): void {
    this._isStreaming = false;
    this._endTime = Date.now();
    this._slidingWindow.reset();
  }

  /**
   * Stops streaming and the native metrics poller. Used for a full stop
   * (session shutdown), not for `agent_end`.
   */
  stop(): void {
    this.stopStreaming();
    this.stopNativeMetrics();
  }

  /**
   * Stops native polling. Called when the task settles (`agent_settled`) or
   * the session shuts down — never at `agent_end`.
   */
  stopNativeMetrics(): void {
    this._native?.stop();
  }

  /**
   * Pauses the timer. Call before a non-edit/write tool call ends.
   * The next `recordDelta` will call `resume()`.
   */
  pause(): void {
    this._isPaused = true;
    this._startPause = Date.now();
  }

  /**
   * Resumes the timer, updating the paused time.
   */
  private resume(): void {
    this._isPaused = false;
    this._pausedMs += Date.now() - this._startPause;
  }

  /**
   * Records a batch of tokens, pushing a timestamped event for TPS calculation.
   *
   * @param tokens The number of tokens to record.
   */
  private recordTokens(tokens: number): void {
    if (!this._isStreaming || tokens <= 0) return;

    this._tokenCount += tokens;
    this._slidingWindow.record(tokens);
    this._tps = this._slidingWindow.getTps(Date.now());
  }

  /**
   * Estimates tokens in a text string using a word-boundary regex.
   * Used as a fallback when the provider doesn't report token counts.
   *
   * @param text The text to estimate token count for.
   * @returns The estimated number of tokens.
   */
  private estimateTokens(text: string): number {
    if (!text) return 0;
    const matches = text.match(TOKEN_REGEX);
    return matches ? matches.length : 0;
  }
}
