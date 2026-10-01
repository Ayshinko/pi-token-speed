import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { OverridesEditor } from "../../src/ui/editor/overrides-editor";

function makeTheme(): Theme {
  return {
    fg: (name: string, text: string) => text,
    bg: (name: string, text: string) => text,
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
    matches: vi.fn((_data: string, id: string) => {
      if (id === "tui.select.cancel") return _data === "\x1b";
      if (id === "tui.select.up") return _data === "up";
      if (id === "tui.select.down") return _data === "down";
      return false;
    }),
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

// ── Minimal mocks ──────────────────────────────────────────────────────────

function makeOptions(overrides: Record<string, unknown> = {}) {
  const persistFn = vi.fn(async (next: Record<string, unknown>) => {
    Object.assign(overrides, next);
  });
  return {
    theme: makeTheme(),
    tui: makeTui(),
    keybindings: makeKeybindings(),
    overrides: { ...overrides },
    persist: persistFn,
    done: vi.fn(),
    onError: vi.fn(),
    onWarning: vi.fn(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("OverridesEditor", () => {
  let editor: OverridesEditor;

  beforeEach(() => {
    vi.clearAllMocks();
    editor = new OverridesEditor(makeOptions() as any);
  });

  it("starts in list mode with no dialogs", () => {
    // @ts-expect-error — private fields; mode/dialogs are implementation
    // details but the bug was exactly about them not being set, so we
    // inspect them directly to catch regressions early.
    expect(editor.mode).toBe("list");
    // @ts-expect-error — private fields; mode/dialogs are implementation
    // details but the bug was exactly about them not being set, so we
    // inspect them directly to catch regressions early.
    expect(editor.mode).toBe("list");
    // @ts-expect-error
    expect(editor.addDialog).toBeUndefined();
    // @ts-expect-error
    expect(editor.confirmDialog).toBeUndefined();
  });

  it("pressing 'a' transitions to add mode and creates the dialog", () => {
    editor.handleInput("a");

    // @ts-expect-error
    expect(editor.mode).toBe("add");
    // @ts-expect-error
    expect(editor.addDialog).toBeDefined();
  });

  it("pressing 'd' transitions to confirm mode and creates the dialog", () => {
    editor = new OverridesEditor(makeOptions({ test: {} }) as any);
    editor.handleInput("d");

    // @ts-expect-error
    expect(editor.mode).toBe("confirm");
    // @ts-expect-error
    expect(editor.confirmDialog).toBeDefined();
  });

  it("cancel on add dialog returns to list mode", () => {
    editor.handleInput("a");

    // @ts-expect-error
    expect(editor.mode).toBe("add");
    // @ts-expect-error
    const dialog = editor.addDialog!;
    dialog.handleInput("\x1b"); // Esc

    // @ts-expect-error
    expect(editor.mode).toBe("list");
    // @ts-expect-error
    expect(editor.addDialog).toBeUndefined();
  });

  it("cancel on confirm dialog returns to list mode", () => {
    editor = new OverridesEditor(makeOptions({ test: {} }) as any);
    editor.handleInput("d");

    // @ts-expect-error
    expect(editor.mode).toBe("confirm");
    // @ts-expect-error
    const dialog = editor.confirmDialog!;
    dialog.handleInput("\x1b"); // Esc

    // @ts-expect-error
    expect(editor.mode).toBe("list");
    // @ts-expect-error
    expect(editor.confirmDialog).toBeUndefined();
  });

  it("submitting add dialog returns to list mode", () => {
    editor.handleInput("a");

    // @ts-expect-error
    const dialog = editor.addDialog!;
    dialog.handleInput("anthropic"); // type the value
    dialog.handleInput("\r"); // Enter to submit

    // @ts-expect-error
    expect(editor.mode).toBe("list");
    // @ts-expect-error
    expect(editor.addDialog).toBeUndefined();
  });
});
