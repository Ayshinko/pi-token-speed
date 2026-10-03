import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { TIERS } from "../../src/settings/options";
import { truecolor } from "../../src/ui/ansi";
import { TierSubmenuBuilder } from "../../src/ui/color-picker";

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

// ── Mock settings ──────────────────────────────────────────────────────────

vi.mock("../../src/config/settings", () => ({
  settings: {
    getConfig: vi.fn(() => ({
      colors: {
        slow: "#ffcc00",
        medium: "#88cc00",
        fast: "#44cc44",
        blazing: "#00ccff",
      },
    })),
  },
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    getSettingsListTheme: () => ({}),
  };
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("truecolor", () => {
  it("returns a single character with 24-bit truecolor ANSI escape", () => {
    const result = truecolor("■", "#ff0000");
    expect(result).toContain("\x1b[38;2;255;0;0m");
    expect(result).toContain("\x1b[0m");
    expect(result).toContain("■");
  });

  it("normalizes hex to lowercase", () => {
    const result = truecolor("■", "#AABBCC");
    expect(result).toContain("\x1b[38;2;170;187;204m");
  });
});

describe("TierSubmenuBuilder.buildColors", () => {
  let builder: TierSubmenuBuilder;

  beforeEach(() => {
    vi.clearAllMocks();
    builder = new TierSubmenuBuilder(makeTheme(), makeTui());
  });

  it("returns one item per tier", () => {
    const items = builder.buildColors();
    expect(items).toHaveLength(TIERS.length);
  });

  it("each item has the correct tier id", () => {
    const items = builder.buildColors();
    for (const tier of TIERS) {
      const item = items.find((i) => i.id === `colors.${tier.key}`);
      expect(item).toBeDefined();
    }
  });

  it("each item label includes the colored block", () => {
    const items = builder.buildColors();
    for (const item of items) {
      expect(item.label).toContain("■");
    }
  });

  it("each item shows the current color value", () => {
    const items = builder.buildColors();
    const expected: Record<string, string> = {
      slow: "#ffcc00",
      medium: "#88cc00",
      fast: "#44cc44",
      blazing: "#00ccff",
    };
    for (const tier of TIERS) {
      const item = items.find((i) => i.id === `colors.${tier.key}`);
      expect(item?.currentValue).toBe(expected[tier.key]);
    }
  });

  it("each item has a submenu factory", () => {
    const items = builder.buildColors();
    for (const item of items) {
      expect(typeof item.submenu).toBe("function");
    }
  });

  it("reads the current config at call time (not cached)", async () => {
    const { settings } = await import("../../src/config/settings");
    (settings.getConfig as any).mockReturnValueOnce({
      colors: {
        slow: "#000000",
        medium: "#111111",
        fast: "#222222",
        blazing: "#333333",
      },
    });

    const items = builder.buildColors();

    expect(items[0].currentValue).toBe("#000000");
  });

  it("submenu factory returns a component when invoked", () => {
    const items = builder.buildColors();
    const done = vi.fn();
    const component = items[0].submenu!("", done);

    expect(component).toBeDefined();
    expect(typeof component.handleInput).toBe("function");
    expect(typeof component.render).toBe("function");
  });
});
