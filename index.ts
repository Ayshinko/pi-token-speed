import type {
  AgentEndEvent,
  AgentSettledEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { CommandManager } from "./src/commands";
import { TokenSpeedEngine } from "./src/core/engine";
import { EventManager } from "./src/core/events";
import { Renderer } from "./src/ui/renderer";

export default async (pi: ExtensionAPI) => {
  const engine = new TokenSpeedEngine();
  const renderer = new Renderer(engine);
  const commands = new CommandManager(renderer, engine);
  const eventManager = new EventManager(engine, renderer);

  // Command registration
  pi.registerCommand("tps", {
    description: "Open settings menu to configure pi-token-speed options",
    getArgumentCompletions: (prefix) => commands.getArgumentCompletions(prefix),
    handler: (args: string, ctx: ExtensionCommandContext) =>
      commands.runTps(args, ctx),
  });

  // Session lifecycle
  pi.on("session_start", async (_, ctx: ExtensionContext) => {
    await eventManager.handleSessionStart(ctx);
  });

  pi.on("session_shutdown", () => {
    eventManager.handleSessionShutdown();
  });

  // Task lifecycle
  //
  // `before_agent_start` fires once when the user submits a prompt, before
  // inference. It does not fire for queued steering/follow-up messages, so
  // the task timer starts exactly once per submitted prompt.
  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx) => {
    eventManager.handleBeforeAgentStart(event, ctx);
  });

  // `agent_settled` fires once when the whole submitted prompt is done
  // (retries, compaction, and queued continuation included): the task timer
  // freezes and native polling stops here, not at `agent_end`.
  pi.on("agent_settled", async (event: AgentSettledEvent, ctx) => {
    await eventManager.handleAgentSettled(event, ctx);
  });

  pi.on("message_update", (event, ctx: ExtensionContext) => {
    eventManager.handleMessageUpdate(event, ctx);
  });

  // `agent_end` closes one assistant stream: reconcile tokens and redraw,
  // keeping the task timer and the native poller alive.
  pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
    await eventManager.handleAgentEnd(event, ctx);
  });
};
