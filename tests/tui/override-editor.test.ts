import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import type { ProviderOverrides } from "../../src/config/types";
import { OverrideSettingsMenu } from "../../src/settings/menu/override-settings-menu";

function makeTheme(): Theme {
  return {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
    bold: (text: string) => text,
    dim: (text: string) => text,
  } as unknown as Theme;
}

function makeTui(): TUI {
  return {
    requestRender: vi.fn(),
    invalidate: vi.fn(),
    onTerminalColorSchemeChange: vi.fn(() => () => {}),
  } as unknown as TUI;
}

function makeKeybindings(): KeybindingsManager {
  return {
    matches: vi.fn(() => false),
    getKeys: vi.fn(() => []),
    getDefinition: vi.fn(),
    getConflicts: vi.fn(() => []),
    setUserBindings: vi.fn(),
    getUserBindings: vi.fn(() => ({})),
    getResolvedBindings: vi.fn(() => ({})),
  } as unknown as KeybindingsManager;
}

// ── Mock settings (must be top-level for vitest) ────────────────────────────

vi.mock("../../src/config/settings", () => ({
  settings: {
    getConfig: () => ({
      display: "tps" as const,
      slidingWindow: 5000,
      useProviderTokens: false,
      countStrategy: "direct" as const,
      endTpsBehavior: "average" as const,
      icon: "⚡",
      updateInterval: 0,
      thresholds: { slow: 10, medium: 30, fast: 60, blazing: 100 },
      colors: {
        slow: "#ffcc00",
        medium: "#88cc00",
        fast: "#44cc44",
        blazing: "#00ccff",
      },
      providerOverrides: {},
    }),
  },
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    getSettingsListTheme: () => ({
      title: (t: string) => t,
      label: (t: string) => t,
      currentValue: (t: string) => t,
      description: (t: string) => t,
      hint: (t: string) => t,
      noItems: (t: string) => t,
    }),
  };
});

// ── Harness ──────────────────────────────────────────────────────────────────

function makeHarness(initial: ProviderOverrides = {}) {
  const overrides: ProviderOverrides = { ...initial };
  const persist = vi.fn(async (next: ProviderOverrides) => {
    Object.keys(overrides).forEach((k) => delete overrides[k]);
    Object.assign(overrides, next);
  });
  const menu = new OverrideSettingsMenu({
    overrides,
    persist,
    onSettingChange: vi.fn(),
    onWarning: vi.fn(),
  });
  const tui = makeTui();
  const theme = makeTheme();
  const done = vi.fn();
  const list = menu.create(tui, theme, makeKeybindings(), done);
  return { menu, list, overrides, persist, tui, done };
}

/** Flushes the microtask chain of persistNext(). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── Tests ────────────────────────────────────────────────────────────────────

describe("OverrideSettingsMenu add/remove hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts with no dialogs open", () => {
    const { menu, list } = makeHarness();
    list.handleInput("x"); // unrelated key: must not open anything

    // @ts-expect-error — private fields; implementation details inspected
    // directly to catch regressions of the dead-key bug early.
    expect(menu.addDialog).toBeUndefined();
    // @ts-expect-error
    expect(menu.confirmDialog).toBeUndefined();
  });

  it("pressing 'a' opens the add-provider dialog", () => {
    const { menu, list } = makeHarness();
    list.handleInput("a");

    // @ts-expect-error
    expect(menu.addDialog).toBeDefined();
  });

  it("pressing 'd' opens the delete confirmation for the selected provider", () => {
    const { menu, list } = makeHarness({ test: {} });
    list.handleInput("d");

    // @ts-expect-error
    expect(menu.confirmDialog).toBeDefined();
  });

  it("cancel on add dialog closes it", () => {
    const { menu, list } = makeHarness();
    list.handleInput("a");

    // @ts-expect-error
    const dialog = menu.addDialog!;
    dialog.handleInput("\x1b"); // Esc

    // @ts-expect-error
    expect(menu.addDialog).toBeUndefined();
  });

  it("cancel on confirm dialog closes it", () => {
    const { menu, list } = makeHarness({ test: {} });
    list.handleInput("d");

    // @ts-expect-error
    const dialog = menu.confirmDialog!;
    dialog.handleInput("\x1b"); // Esc

    // @ts-expect-error
    expect(menu.confirmDialog).toBeUndefined();
  });

  it("submitting the add dialog persists the new provider", async () => {
    const { menu, list, overrides, persist } = makeHarness();
    list.handleInput("a");

    // @ts-expect-error
    const dialog = menu.addDialog!;
    dialog.handleInput("anthropic"); // type the provider id
    dialog.handleInput("\r"); // Enter to submit
    await flush();

    expect(persist).toHaveBeenCalled();
    expect(overrides["anthropic"]).toEqual({});
    // @ts-expect-error
    expect(menu.addDialog).toBeUndefined();
  });

  it("confirming delete persists the removal", async () => {
    const { menu, list, overrides, persist } = makeHarness({
      test: { icon: "⚡" },
    });
    list.handleInput("d");

    // @ts-expect-error
    const dialog = menu.confirmDialog!;
    // confirm is the first row of the dialog's SelectList
    dialog.handleInput("\r");
    await flush();

    expect(persist).toHaveBeenCalled();
    expect(overrides["test"]).toBeUndefined();
    // @ts-expect-error
    expect(menu.confirmDialog).toBeUndefined();
  });
});
