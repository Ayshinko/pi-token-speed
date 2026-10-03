import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { TIERS } from "../../src/settings/options";
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
      thresholds: { slow: 10, medium: 30, fast: 60, blazing: 100 },
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

describe("TierSubmenuBuilder.buildThresholds", () => {
  let builder: TierSubmenuBuilder;

  beforeEach(() => {
    vi.clearAllMocks();
    builder = new TierSubmenuBuilder(makeTheme(), makeTui());
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns one item per tier", () => {
    const items = builder.buildThresholds();
    expect(items).toHaveLength(TIERS.length);
  });

  it("each item has the correct tier id and label", () => {
    const items = builder.buildThresholds();
    for (const tier of TIERS) {
      const item = items.find((i) => i.id === `thresholds.${tier.key}`);
      expect(item).toBeDefined();
      expect(item?.label).toBe(tier.label);
    }
  });

  it("each item shows the current threshold value", () => {
    const items = builder.buildThresholds();
    const expected: Record<string, string> = {
      slow: "10",
      medium: "30",
      fast: "60",
      blazing: "100",
    };
    for (const tier of TIERS) {
      const item = items.find((i) => i.id === `thresholds.${tier.key}`);
      expect(item?.currentValue).toBe(expected[tier.key]);
    }
  });

  it("each item has a submenu factory", () => {
    const items = builder.buildThresholds();
    for (const item of items) {
      expect(typeof item.submenu).toBe("function");
    }
  });

  it("reads the current config at call time (not cached)", async () => {
    const { settings } = await import("../../src/config/settings");
    (settings.getConfig as any).mockReturnValueOnce({
      thresholds: { slow: 99, medium: 99, fast: 99, blazing: 99 },
    });

    const items = builder.buildThresholds();

    expect(items[0].currentValue).toBe("99");
  });

  it("submenu factory returns a component when invoked", () => {
    const items = builder.buildThresholds();
    const done = vi.fn();
    const component = items[0].submenu!("", done);

    expect(component).toBeDefined();
    expect(typeof component.handleInput).toBe("function");
    expect(typeof component.render).toBe("function");
  });
});
