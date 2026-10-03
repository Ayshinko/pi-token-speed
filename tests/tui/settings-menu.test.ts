import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SettingItem, TUI } from "@earendil-works/pi-tui";
import { settings } from "../../src/config/settings";
import { SettingsMenu } from "../../src/settings/menu/settings-menu";

// ── Mock settings ──────────────────────────────────────────────────────────

// Stateful mock mirroring the real `Settings` semantics: `setConfig`
// replaces the cached config with a NEW merged object (like `mergeConfig`),
// so references captured earlier (e.g. a menu's `opts.config` snapshot)
// become stale. This is what makes a stale-submenu regression detectable.
const settingsState = vi.hoisted(() => {
  const makeDefaults = () => ({
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
  });
  let current: ReturnType<typeof makeDefaults> = makeDefaults();
  return {
    makeDefaults,
    get config() {
      return current;
    },
    set config(value: ReturnType<typeof makeDefaults>) {
      current = value;
    },
  };
});

/**
 * Merges a partial config into the mocked cache, replacing the cached
 * object (same semantics as the real `mergeConfig`).
 *
 * @param partial The partial config to apply.
 */
async function mockSetConfig(partial: Record<string, unknown>): Promise<void> {
  const current = settingsState.config;
  settingsState.config = {
    ...current,
    ...partial,
    thresholds: {
      ...current.thresholds,
      ...(partial.thresholds as Record<string, unknown> | undefined),
    },
    colors: {
      ...current.colors,
      ...(partial.colors as Record<string, unknown> | undefined),
    },
    providerOverrides: {
      ...current.providerOverrides,
      ...(partial.providerOverrides as Record<string, unknown> | undefined),
    },
  } as typeof current;
}

vi.mock("../../src/config/settings", () => ({
  settings: {
    getConfig: vi.fn(() => settingsState.config),
    getDefaultConfig: vi.fn(() => settingsState.makeDefaults()),
    setConfig: vi.fn(mockSetConfig),
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SettingsMenu", () => {
  let menu: SettingsMenu;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks() wipes the stateful setConfig implementation set by
    // earlier tests (e.g. mockResolvedValue) — restore it.
    (settings.setConfig as any).mockImplementation(mockSetConfig);
    settingsState.config = settingsState.makeDefaults();
    menu = new SettingsMenu({
      config: settings.getConfig(),
      onSettingChange: vi.fn(),
    });
  });

  // ── buildSettingsItems ───────────────────────────────────────────────

  describe("buildSettingsItems", () => {
    it("includes all scalar settings", () => {
      const tui = makeTui();
      const items = (menu as any).buildSettingsItems(
        settings.getConfig(),
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
        makeTheme(),
        tui,
      );

      const colorsItem = items.find((i: SettingItem) => i.id === "colors");
      expect(colorsItem).toBeDefined();
      expect(typeof colorsItem?.submenu).toBe("function");
    });
  });

  // ── createMainSettingsList ───────────────────────────────────────────

  describe("createMainSettingsList", () => {
    it("creates a list with correct items", () => {
      const tui = makeTui();
      const onChange = vi.fn();
      const onCancel = vi.fn();
      const onReset = vi.fn();
      const items = [
        { id: "test", label: "Test", currentValue: "value" },
      ] as SettingItem[];

      const list = (menu as any).createMainSettingsList(
        items,
        items.length,
        onChange,
        onCancel,
        onReset,
        tui,
      );

      expect(list).toBeDefined();
      expect((list as any).items).toEqual(items);
    });

    it("calls onCancel when the list is closed", () => {
      const tui = makeTui();
      const onChange = vi.fn();
      const onCancel = vi.fn();
      const onReset = vi.fn();
      const items = [
        { id: "test", label: "Test", currentValue: "value" },
      ] as SettingItem[];

      const list = (menu as any).createMainSettingsList(
        items,
        items.length,
        onChange,
        onCancel,
        onReset,
        tui,
      );

      (list as any).onCancel();
      expect(onCancel).toHaveBeenCalled();
    });
  });

  // ── createSubmenuList ────────────────────────────────────────────────

  describe("createSubmenuList", () => {
    it("stores items for threshold submenus", () => {
      const tui = makeTui();
      const done = vi.fn();
      const items = [{ id: "thresholds.slow", label: "Slow" }] as SettingItem[];

      const list = (menu as any).createSubmenuList(
        items,
        Math.min(items.length + 2, 15),
        () => {},
        done,
        () => {},
        tui,
      );

      expect((menu as any).thresholdSubmenuItems).toEqual(items);
      expect((menu as any).activeSubmenuList).toBe(list);
    });

    it("stores items for color submenus", () => {
      const tui = makeTui();
      const done = vi.fn();
      const items = [{ id: "colors.slow", label: "Slow" }] as SettingItem[];

      const list = (menu as any).createSubmenuList(
        items,
        Math.min(items.length + 2, 15),
        () => {},
        done,
        () => {},
        tui,
      );

      expect((menu as any).colorSubmenuItems).toEqual(items);
      expect((menu as any).activeSubmenuList).toBe(list);
    });

    it("clears stored items when submenu closes", () => {
      const tui = makeTui();
      const done = vi.fn();
      const items = [{ id: "thresholds.slow", label: "Slow" }] as SettingItem[];

      const list = (menu as any).createSubmenuList(
        items,
        Math.min(items.length + 2, 15),
        () => {},
        done,
        () => {},
        tui,
      );

      // Close the submenu
      (list as any).onCancel();

      expect((menu as any).thresholdSubmenuItems).toBeNull();
      expect((menu as any).activeSubmenuList).toBeNull();
      expect(done).toHaveBeenCalled();
    });
  });

  // ── handleSettingChange ──────────────────────────────────────────────

  describe("handleSettingChange", () => {
    it("calls onSettingChange on success", async () => {
      const onSettingChange = vi.fn();
      const menu2 = new SettingsMenu({
        config: settings.getConfig(),
        onSettingChange,
      });

      (settings.setConfig as any).mockResolvedValue(undefined);

      await (menu2 as any).handleSettingChange("display", "TPS speed");

      expect(onSettingChange).toHaveBeenCalled();
    });

    it("does nothing when validation fails", async () => {
      const onSettingChange = vi.fn();
      const menu2 = new SettingsMenu({
        config: settings.getConfig(),
        onSettingChange,
      });

      (settings.setConfig as any).mockResolvedValue(undefined);

      await (menu2 as any).handleSettingChange("display", "invalid-value");

      expect(onSettingChange).not.toHaveBeenCalled();
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
      const list = (menu as any).createMainSettingsList(
        items,
        items.length,
        () => {},
        () => {},
        () => {},
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
      const done = vi.fn();
      const items = [
        { id: "thresholds.slow", label: "Slow", currentValue: "10" },
        { id: "thresholds.medium", label: "Medium", currentValue: "30" },
      ] as SettingItem[];

      (menu as any).createSubmenuList(
        items,
        Math.min(items.length + 2, 15),
        () => {},
        done,
        () => {},
        tui,
      );

      // Mutate the internal items
      (menu as any).refreshThresholdItems();

      expect((menu as any).thresholdSubmenuItems![0].currentValue).toBe("10");
    });

    it("invalidates the active submenu list", () => {
      const tui = makeTui();
      const done = vi.fn();
      const items = [{ id: "thresholds.slow", label: "Slow" }] as SettingItem[];

      const list = (menu as any).createSubmenuList(
        items,
        Math.min(items.length + 2, 15),
        () => {},
        done,
        () => {},
        tui,
      );

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
      const list = (menu as any).createMainSettingsList(
        items,
        items.length,
        () => {},
        () => {},
        () => {},
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
      const done = vi.fn();
      const items = [
        { id: "colors.slow", label: "■ Slow", currentValue: "#ffcc00" },
      ] as SettingItem[];

      (menu as any).createSubmenuList(
        items,
        Math.min(items.length + 2, 15),
        () => {},
        done,
        () => {},
        tui,
      );

      (menu as any).refreshColorItems();

      expect((menu as any).colorSubmenuItems![0].currentValue).toBe("#ffcc00");
    });

    it("updates the open submenu list after a color change", async () => {
      const tui = makeTui();
      const items = [
        { id: "colors.slow", label: "■ Slow", currentValue: "#ffcc00" },
        { id: "colors.medium", label: "■ Medium", currentValue: "#88cc00" },
        { id: "colors.fast", label: "■ Fast", currentValue: "#44cc44" },
        { id: "colors.blazing", label: "■ Blazing", currentValue: "#00ccff" },
      ] as SettingItem[];

      const list = (menu as any).createSubmenuList(
        items,
        Math.min(items.length + 2, 15),
        (id: string, v: string) => (menu as any).handleSettingChange(id, v),
        () => {},
        () => {},
        tui,
      );

      await (menu as any).handleSettingChange("colors.slow", "#123456");

      const refreshed = (list as any).items.find(
        (i: SettingItem) => i.id === "colors.slow",
      );
      expect(refreshed.currentValue).toBe("#123456");
    });
  });

  // ── Stale-submenu regression ──────────────────────────────────────

  describe("stale submenu regression", () => {
    it("refreshes the threshold submenu from live config after a change", async () => {
      const tui = makeTui();
      const items = [
        { id: "thresholds.slow", label: "Slow", currentValue: "10" },
        { id: "thresholds.medium", label: "Medium", currentValue: "30" },
        { id: "thresholds.fast", label: "Fast", currentValue: "60" },
        { id: "thresholds.blazing", label: "Blazing", currentValue: "100" },
      ] as SettingItem[];

      (menu as any).createSubmenuList(
        items,
        Math.min(items.length + 2, 15),
        (id: string, v: string) => (menu as any).handleSettingChange(id, v),
        () => {},
        () => {},
        tui,
      );

      // The menu captured a config snapshot at construction time; the real
      // setConfig replaces the cached config object, so the refresh must
      // re-read from settings (not from the stale snapshot).
      await (menu as any).handleSettingChange("thresholds.slow", "3");

      expect(settingsState.config.thresholds.slow).toBe(3);
      const refreshed = (menu as any).thresholdSubmenuItems.find(
        (i: SettingItem) => i.id === "thresholds.slow",
      );
      expect(refreshed.currentValue).toBe("3");
    });

    it("refreshes the open threshold submenu list from live config", async () => {
      const tui = makeTui();
      const items = [
        { id: "thresholds.slow", label: "Slow", currentValue: "10" },
        { id: "thresholds.medium", label: "Medium", currentValue: "30" },
        { id: "thresholds.fast", label: "Fast", currentValue: "60" },
        { id: "thresholds.blazing", label: "Blazing", currentValue: "100" },
      ] as SettingItem[];

      const list = (menu as any).createSubmenuList(
        items,
        Math.min(items.length + 2, 15),
        (id: string, v: string) => (menu as any).handleSettingChange(id, v),
        () => {},
        () => {},
        tui,
      );

      await (menu as any).handleSettingChange("thresholds.slow", "3");

      const refreshed = (list as any).items.find(
        (i: SettingItem) => i.id === "thresholds.slow",
      );
      expect(refreshed.currentValue).toBe("3");
    });

    it("refreshes the color submenu from live config after a change", async () => {
      const tui = makeTui();
      const items = [
        { id: "colors.slow", label: "■ Slow", currentValue: "#ffcc00" },
        { id: "colors.medium", label: "■ Medium", currentValue: "#88cc00" },
        { id: "colors.fast", label: "■ Fast", currentValue: "#44cc44" },
        { id: "colors.blazing", label: "■ Blazing", currentValue: "#00ccff" },
      ] as SettingItem[];

      (menu as any).createSubmenuList(
        items,
        Math.min(items.length + 2, 15),
        (id: string, v: string) => (menu as any).handleSettingChange(id, v),
        () => {},
        () => {},
        tui,
      );

      await (menu as any).handleSettingChange("colors.slow", "#123456");

      expect(settingsState.config.colors.slow).toBe("#123456");
      const colorItem = (menu as any).colorSubmenuItems.find(
        (i: SettingItem) => i.id === "colors.slow",
      );
      expect(colorItem.currentValue).toBe("#123456");
    });
  });
});
