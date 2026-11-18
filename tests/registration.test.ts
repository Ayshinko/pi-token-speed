import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index";

/**
 * The task lifecycle must be wired to the events that bracket a submitted
 * prompt, not to the per-stream events.
 */
describe("extension event registration", () => {
  const register = () => {
    const handlers: Record<string, unknown> = {};
    const pi = {
      registerCommand: vi.fn(),
      on: (name: string, handler: unknown) => {
        handlers[name] = handler;
      },
    } as unknown as ExtensionAPI;
    return { handlers, pi };
  };

  it("starts the task at before_agent_start and freezes it at agent_settled", async () => {
    const { handlers, pi } = register();
    await extension(pi);

    expect(handlers["before_agent_start"]).toBeTypeOf("function");
    expect(handlers["agent_settled"]).toBeTypeOf("function");
    expect(handlers["session_start"]).toBeTypeOf("function");
    expect(handlers["session_shutdown"]).toBeTypeOf("function");
    expect(handlers["agent_end"]).toBeTypeOf("function");
    expect(handlers["message_update"]).toBeTypeOf("function");
  });

  it("does not start the task from message_start (queued steering would reset it)", async () => {
    const { handlers, pi } = register();
    await extension(pi);

    expect(handlers["message_start"]).toBeUndefined();
  });
});
