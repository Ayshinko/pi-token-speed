import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SettingItem, TUI } from "@earendil-works/pi-tui";
import { settings } from "../../src/config/settings";
import type { TokenSpeedEngine } from "../../src/core/engine";
import { SettingsMenu } from "../../src/settings/menu";
import type { Renderer } from "../../src/ui/renderer";

// ── Mock settings ──────────────────────────────────────────────────────────

vi.mock("../../src/config/settings", () => ({
  settings: {
    getConfig: vi.fn(() => ({
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
    })),
    getDefaultConfig: vi.fn(() => ({
      thresholds: { slow: 10, medium: 30, fast: 60, blazing: 100 },
      colors: {
        slow: "#ffcc00",
        medium: "#88cc00",
        fast: "#44cc44",
        blazing: "#00ccff",
      },
      display: "tps",
      slidingWindow: 5000,
      useProviderTokens: false,
      countStrategy: "direct",
      endTpsBehavior: "average",
      icon: "⚡",
      updateInterval: 0,
      providerOverrides: {},
    })),
    setConfig: vi.fn(),
  },
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    getSettingsListTheme: () => ({}),
  };
});

// ── Minimal mocks ──────────────────────────────────────────────────────────

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

function makeEngine(): TokenSpeedEngine {
  return {
    initialize: vi.fn(),
    applyProvider: vi.fn(),
  } as unknown as TokenSpeedEngine;
}

function makeRenderer(): Renderer {
  return {
    update: vi.fn(),
  } as unknown as Renderer;
}

function makeCtx() {
  return {
    ui: { notify: vi.fn() },
    mode: "tui",
    model: { provider: "test" },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SettingsMenu", () => {
  let menu: SettingsMenu;
  let engine: TokenSpeedEngine;
  let renderer: Renderer;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = makeEngine();
    renderer = makeRenderer();
    menu = new SettingsMenu(renderer, engine);
  });

  // ── buildSettingsItems ───────────────────────────────────────────────

  describe("buildSettingsItems", () => {
    it("includes all scalar settings", () => {
      const tui = makeTui();
      const items = (menu as any).buildSettingsItems(
        settings.getConfig(),
        makeCtx(),
        makeTheme(),
        tui,
      );

      const ids = items.map((i: SettingItem) => i.id);
      expect(ids).toContain("display");
      expect(ids).toContain("icon");
      expect(ids).toContain("updateInterval");
      expect(ids).toContain("useProviderTokens");
      expect(ids).toContain("countStrategy");
      expect(ids).toContain("slidingWindow");
      expect(ids).toContain("endTpsBehavior");
    });

    it("includes thresholds group entry", () => {
      const tui = makeTui();
      const items = (menu as any).buildSettingsItems(
        settings.getConfig(),
        makeCtx(),
        makeTheme(),
        tui,
      );

      const thresholdsItem = items.find(
        (i: SettingItem) => i.id === "thresholds",
      );
      expect(thresholdsItem).toBeDefined();
      expect(thresholdsItem?.currentValue).toContain("10");
      expect(thresholdsItem?.currentValue).toContain("30");
      expect(thresholdsItem?.currentValue).toContain("60");
      expect(thresholdsItem?.currentValue).toContain("100");
      expect(typeof thresholdsItem?.submenu).toBe("function");
    });

    it("includes colors group entry", () => {
      const tui = makeTui();
      const items = (menu as any).buildSettingsItems(
        settings.getConfig(),
        makeCtx(),
        makeTheme(),
        tui,
      );

      const colorsItem = items.find((i: SettingItem) => i.id === "colors");
      expect(colorsItem).toBeDefined();
      expect(typeof colorsItem?.submenu).toBe("function");
    });
  });

  // ── createSettingsList ───────────────────────────────────────────────

  describe("createSettingsList", () => {
    it("creates a list with correct items", () => {
      const tui = makeTui();
      const onClose = vi.fn();
      const ctx = makeCtx();
      const items = [
        { id: "test", label: "Test", currentValue: "value" },
      ] as SettingItem[];

      const list = (menu as any).createSettingsList(items, onClose, ctx, tui);

      expect(list).toBeDefined();
      expect((list as any).items).toEqual(items);
    });

    it("calls onClose when the list is closed", () => {
      const tui = makeTui();
      const onClose = vi.fn();
      const ctx = makeCtx();
      const items = [
        { id: "test", label: "Test", currentValue: "value" },
      ] as SettingItem[];

      const list = (menu as any).createSettingsList(items, onClose, ctx, tui);

      (list as any).onCancel();
      expect(onClose).toHaveBeenCalled();
    });
  });

  // ── createSubmenuList ────────────────────────────────────────────────

  describe("createSubmenuList", () => {
    it("stores items for threshold submenus", () => {
      const tui = makeTui();
      const ctx = makeCtx();
      const done = vi.fn();
      const items = [{ id: "thresholds.slow", label: "Slow" }] as SettingItem[];

      const list = (menu as any).createSubmenuList(items, ctx, tui, done);

      expect((menu as any).thresholdSubmenuItems).toEqual(items);
      expect((menu as any).activeSubmenuList).toBe(list);
    });

    it("stores items for color submenus", () => {
      const tui = makeTui();
      const ctx = makeCtx();
      const done = vi.fn();
      const items = [{ id: "colors.slow", label: "Slow" }] as SettingItem[];

      const list = (menu as any).createSubmenuList(items, ctx, tui, done);

      expect((menu as any).colorSubmenuItems).toEqual(items);
      expect((menu as any).activeSubmenuList).toBe(list);
    });

    it("clears stored items when submenu closes", () => {
      const tui = makeTui();
      const ctx = makeCtx();
      const done = vi.fn();
      const items = [{ id: "thresholds.slow", label: "Slow" }] as SettingItem[];

      const list = (menu as any).createSubmenuList(items, ctx, tui, done);

      // Close the submenu
      (list as any).onCancel();

      expect((menu as any).thresholdSubmenuItems).toBeNull();
      expect((menu as any).activeSubmenuList).toBeNull();
      expect(done).toHaveBeenCalled();
    });
  });

  // ── handleSettingChange ──────────────────────────────────────────────

  describe("handleSettingChange", () => {
    it("calls engine.initialize and renderer.update on success", async () => {
      const ctx = makeCtx();
      (settings.setConfig as any).mockResolvedValue(undefined);

      await (menu as any).handleSettingChange("display", "TPS speed", ctx);

      expect(engine.initialize).toHaveBeenCalled();
      expect(renderer.update).toHaveBeenCalledWith(ctx);
    });

    it("shows a warning when validation fails", async () => {
      const ctx = makeCtx();
      (settings.setConfig as any).mockResolvedValue(undefined);

      await (menu as any).handleSettingChange("display", "invalid-value", ctx);

      expect(
        (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify,
      ).toHaveBeenCalled();
    });
  });

  // ── refreshThresholdItems ────────────────────────────────────────────

  describe("refreshThresholdItems", () => {
    it("updates the main list thresholds value", () => {
      const tui = makeTui();
      const items = [
        {
          id: "thresholds",
          label: "Thresholds",
          currentValue: "10 | 30 | 60 | 100",
        },
      ] as SettingItem[];
      const list = (menu as any).createSettingsList(
        items,
        () => {},
        makeCtx(),
        tui,
      );

      (menu as any).refreshThresholdItems();

      expect(
        (list as any).items.find((i: SettingItem) => i.id === "thresholds")
          .currentValue,
      ).toBe("10 | 30 | 60 | 100");
    });

    it("updates threshold submenu items", () => {
      const tui = makeTui();
      const ctx = makeCtx();
      const done = vi.fn();
      const items = [
        { id: "thresholds.slow", label: "Slow", currentValue: "10" },
        { id: "thresholds.medium", label: "Medium", currentValue: "30" },
      ] as SettingItem[];

      (menu as any).createSubmenuList(items, ctx, tui, done);

      // Mutate the internal items
      (menu as any).refreshThresholdItems();

      expect((menu as any).thresholdSubmenuItems![0].currentValue).toBe("10");
    });

    it("invalidates the active submenu list", () => {
      const tui = makeTui();
      const ctx = makeCtx();
      const done = vi.fn();
      const items = [{ id: "thresholds.slow", label: "Slow" }] as SettingItem[];

      const list = (menu as any).createSubmenuList(items, ctx, tui, done);

      (menu as any).refreshThresholdItems();

      expect((list as any).invalidate).toBeDefined();
    });
  });

  // ── refreshColorItems ────────────────────────────────────────────────

  describe("refreshColorItems", () => {
    it("updates the main list colors value", () => {
      const tui = makeTui();
      const items = [
        { id: "colors", label: "Colors", currentValue: "■ ■ ■ ■" },
      ] as SettingItem[];
      const list = (menu as any).createSettingsList(
        items,
        () => {},
        makeCtx(),
        tui,
      );

      (menu as any).refreshColorItems();

      expect(
        (list as any).items.find((i: SettingItem) => i.id === "colors")
          .currentValue,
      ).toContain("■");
    });

    it("updates color submenu items", () => {
      const tui = makeTui();
      const ctx = makeCtx();
      const done = vi.fn();
      const items = [
        { id: "colors.slow", label: "■ Slow", currentValue: "#ffcc00" },
      ] as SettingItem[];

      (menu as any).createSubmenuList(items, ctx, tui, done);

      (menu as any).refreshColorItems();

      expect((menu as any).colorSubmenuItems![0].currentValue).toBe("#ffcc00");
    });
  });
});
