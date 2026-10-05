import type {
  AgentEndEvent,
  AgentSettledEvent,
  BeforeAgentStartEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { TOKEN_GENERATION_TOOLS } from "../config/constants";
import { settings } from "../config/settings";
import { Renderer } from "../ui/renderer";
import { TokenSpeedEngine } from "./engine";
import type { MessageUpdatePayload } from "./message-handler";
import { MessageHandlerRegistry } from "./message-handler";
import {
  DeltaHandler,
  StreamStartHandler,
  ToolcallDeltaHandler,
  ToolcallEndHandler,
} from "./message-handlers";

/**
 * Manages all Pi event subscriptions for the token-speed extension.
 *
 * Task boundaries:
 * - `before_agent_start` fires once when the user submits a prompt, before
 *   the user message is added. It does not fire for queued steering or
 *   follow-up messages, for retries, compaction, or continuation, so it is
 *   the task start.
 * - `agent_end` closes one assistant stream. The task is not over: tool
 *   calls, retries, compaction, and queued continuation can follow, so the
 *   task timer and the native poller survive it.
 * - `agent_settled` fires once when the whole submitted prompt is done. It
 *   is the task end: the task timer freezes there and native polling stops.
 */
export class EventManager {
  private readonly registry: MessageHandlerRegistry;
  /** Most recent extension context, used to redraw when no event carries one. */
  private ctx: ExtensionContext | undefined;

  constructor(
    private readonly engine: TokenSpeedEngine,
    private readonly renderer: Renderer,
  ) {
    this.registry = new MessageHandlerRegistry();
    this.registry.register(
      new StreamStartHandler(engine, (ctx) => ctx.model?.provider),
    );
    this.registry.register(new DeltaHandler(engine, renderer));
    this.registry.register(new ToolcallDeltaHandler(engine, renderer));
    this.registry.register(
      new ToolcallEndHandler(
        engine,
        (name) => !TOKEN_GENERATION_TOOLS.has(name),
      ),
    );
  }

  /**
   * Initializes the engine and renderer for a new session.
   *
   * @param ctx The Pi extension context.
   */
  async handleSessionStart(ctx: ExtensionContext): Promise<void> {
    await settings.initialize();
    const errors = settings.getErrors();

    if (errors.length > 0) {
      const message = ["[pi-token-speed]", ...errors].join("\n");
      ctx.ui.notify(message, "warning");
    }

    this.ctx = ctx;
    this.engine.initialize();
    this.engine.applyProvider(ctx.model?.provider);

    // Native snapshots change while the stream is quiet (prefill, long tool
    // calls), when no text delta arrives and the delta-driven renderer never
    // fires. The poller notifies this listener on meaningful changes; the
    // renderer's setStatus path invalidates the TUI footer.
    this.engine.setNativeUpdateListener(() => {
      if (this.ctx) this.renderer.update(this.ctx);
    });

    this.renderer.initialize(ctx);
    this.renderer.resetThrottle();
  }

  /**
   * Stops the engine, the native poller, and the task timer on shutdown.
   */
  handleSessionShutdown(): void {
    this.engine.stop();
    this.engine.clearTask();
    this.engine.setNativeUpdateListener(undefined);
    this.ctx = undefined;
  }

  /**
   * Starts the task timer, TTFT, and the native adapter when the user
   * submits a prompt.
   *
   * The provider override is applied first so the adapter is armed with the
   * settings of the model that will run. Arming before inference lets the
   * adapter observe the prompt-processing phase and capture the request
   * baseline before this request finishes.
   *
   * @param _event The before_agent_start event payload (prompt text; unused).
   * @param ctx The Pi extension context.
   */
  handleBeforeAgentStart(
    _event: BeforeAgentStartEvent,
    ctx: ExtensionContext,
  ): void {
    this.ctx = ctx;
    this.engine.applyProvider(ctx.model?.provider);
    this.engine.startTask();
    this.engine.startTTFT();
    this.engine.startNativeMetrics();
  }

  /**
   * Routes message update events through the handler registry.
   *
   * @param event The message_update event payload.
   * @param ctx The Pi extension context.
   */
  handleMessageUpdate(
    event: MessageUpdatePayload,
    ctx: ExtensionContext,
  ): void {
    this.ctx = ctx;
    this.registry.handle(event, ctx);
  }

  /**
   * Reconciles the total token count and updates the renderer at the end of
   * one assistant stream.
   *
   * Does not freeze the task timer and does not stop native polling: the task
   * is not finished, so the footer keeps updating until the task settles.
   *
   * @param event The agent_end event payload.
   * @param ctx The Pi extension context.
   */
  handleAgentEnd(event: AgentEndEvent, ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.engine.stopStreaming();

    // Only assistant and toolResult messages carry usage data
    const outputTokens = event.messages.reduce((acc, curr) => {
      if (curr.role === "assistant") {
        return acc + curr.usage.output;
      }
      if (curr.role === "toolResult") {
        return acc + (curr.usage?.output ?? 0);
      }
      return acc;
    }, 0);

    this.engine.reconcileTotal(outputTokens);
    this.renderer.update(ctx);
  }

  /**
   * Ends the task: gives the native adapter one bounded chance to read the
   * finished request record, freezes the task timer, stops polling, and
   * renders the final status.
   *
   * @param _event The agent_settled event payload (unused).
   * @param ctx The Pi extension context.
   */
  async handleAgentSettled(
    _event: AgentSettledEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    this.ctx = ctx;
    this.engine.stopStreaming();
    // Bounded end-of-task fetch (never throws). Stops polling on success and
    // falls back to the last live snapshot when the endpoint is unavailable.
    await this.engine.finalizeNativeMetrics();
    this.engine.finishTask();
    this.engine.stopNativeMetrics();

    this.renderer.resetThrottle();
    this.renderer.update(ctx);
  }
}
