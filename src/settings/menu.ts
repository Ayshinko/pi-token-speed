import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { SettingItem, SettingsList, TUI } from "@earendil-works/pi-tui";
import { settings } from "../config/settings";
import type { TokenSpeedConfig } from "../config/types";
import type { TokenSpeedEngine } from "../core/engine";
import { truecolor } from "../ui/ansi";
import { TierSubmenuBuilder } from "../ui/color-picker";
import { OverridesEditor } from "../ui/editor/overrides-editor";
import type { Renderer } from "../ui/renderer";
import { ResettableSettingsList } from "../ui/resettable-settings-list";
import { SETTINGS_ITEMS, TIER_SETTINGS_ITEMS } from "./defaults";
import { TIERS } from "./options";

/**
 * Orchestrates the settings UI: dialogs, menus, and state management.
 * Owns all `ctx` usage.
 */
export class SettingsMenu {
  private settingsList: SettingsList | null = null;
  private colorSubmenuItems: SettingItem[] | null = null;
  private thresholdSubmenuItems: SettingItem[] | null = null;
  /** Currently active submenu SettingsList (colors or thresholds). */
  private activeSubmenuList: SettingsList | null = null;

  constructor(
    private readonly renderer: Renderer,
    private readonly engine: TokenSpeedEngine,
  ) {}

  /**
   * Shows the base settings menu as a custom dialog.
   */
  async showSettingsMenu(ctx: ExtensionCommandContext): Promise<void> {
    const config = settings.getConfig();

    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      const items = this.buildSettingsItems(config, ctx, theme, tui);
      this.settingsList = this.createSettingsList(items, done, ctx, tui);
      return this.settingsList;
    });
  }

  /**
   * Shows the per-provider overrides editor.
   */
  async showOverridesEditor(ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(
        "/tps overrides requires an interactive session (TUI)",
        "warning",
      );
      return;
    }

    const overrides = settings.getConfig().providerOverrides;
    await ctx.ui.custom<void>(
      (tui, theme, keybindings, done) =>
        new OverridesEditor({
          tui,
          theme,
          keybindings,
          overrides: { ...overrides },
          persist: (next) => settings.setProviderOverrides(next),
          done: () => {
            done(undefined);
            // Re-apply the current provider's effective config so changes
            // take effect immediately
            this.engine.initialize();
            this.engine.applyProvider(ctx.model?.provider);
            this.renderer.update(ctx);
          },
          onError: (message) => ctx.ui.notify(message, "error"),
          onWarning: (message) => ctx.ui.notify(message, "warning"),
        }),
    );
  }

  // ── Settings list management ────────────────────────────────────────

  /**
   * Handles a setting change: validates, persists, and re-applies.
   *
   * @param id The setting identifier.
   * @param newValue The new value to set.
   * @param ctx The command context for notifications.
   */
  private async handleSettingChange(
    id: string,
    newValue: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const config = settings.getConfig();
    const item = SETTINGS_ITEMS[id] ?? TIER_SETTINGS_ITEMS[id];
    if (item) {
      const result = item.setConfig(config, newValue);
      if (!result.valid) {
        ctx.ui.notify(result.errors!.join("\n"), "warning");
        return;
      }
      await settings.setConfig(result.config!);
    }

    await this.reapplyAfterChange(id, ctx);
  }

  /**
   * Resets a setting to its default value and re-applies.
   *
   * @param id The setting identifier.
   * @param ctx The command context for notifications.
   */
  private async resetSetting(
    id: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const defaults = settings.getDefaultConfig();
    const item = SETTINGS_ITEMS[id] ?? TIER_SETTINGS_ITEMS[id];
    if (item) {
      const partial = item.reset(defaults);
      if (Object.keys(partial).length > 0) {
        await settings.setConfig(partial);
      }
    }

    // Reflect the reset value in the main menu's row
    const mainValue = item ? item.format(settings.getConfig()) : undefined;
    if (mainValue !== undefined) {
      this.settingsList?.updateValue(id, mainValue);
    }

    await this.reapplyAfterChange(id, ctx);
  }

  /**
   * Re-initializes the engine, re-renders, and refreshes the appropriate list.
   */
  private async reapplyAfterChange(
    id: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    this.engine.initialize();
    this.renderer.update(ctx);
    this.refreshListAfterChange(id);
  }

  /**
   * Creates a resettable SettingsList for the main settings menu.
   *
   * @param items The settings items to display.
   * @param onClose Callback when the user closes the list.
   * @param ctx The command context for notifications.
   * @param tui The TUI instance for re-renders.
   * @returns A configured SettingsList.
   */
  private createSettingsList(
    items: SettingItem[],
    onClose: () => void,
    ctx: ExtensionCommandContext,
    tui: TUI,
  ): SettingsList {
    return new ResettableSettingsList(
      items,
      items.length,
      getSettingsListTheme(),
      (id, newValue) => this.handleSettingChange(id, newValue, ctx),
      onClose,
      (id) => void this.resetSetting(id, ctx),
      tui,
    );
  }

  /**
   * Creates a resettable SettingsList for a submenu (colors or thresholds).
   *
   * @param items The submenu items to display.
   * @param ctx The command context for notifications.
   * @param tui The TUI instance for re-renders.
   * @param done Callback when the submenu is closed.
   * @returns A configured SettingsList.
   */
  private createSubmenuList(
    items: SettingItem[],
    ctx: ExtensionCommandContext,
    tui: TUI,
    done: (value?: string) => void,
  ): SettingsList {
    // Capture items so refresh functions can update them
    const isThresholds = items.some((i) => i.id.startsWith("thresholds."));
    if (isThresholds) {
      this.thresholdSubmenuItems = items;
    } else {
      this.colorSubmenuItems = items;
    }

    const list = new ResettableSettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, newValue) => this.handleSettingChange(id, newValue, ctx),
      () => {
        this.activeSubmenuList = null;
        if (isThresholds) {
          this.thresholdSubmenuItems = null;
        } else {
          this.colorSubmenuItems = null;
        }
        done(undefined);
      },
      (id) => void this.resetSetting(id, ctx),
      tui,
    );
    this.activeSubmenuList = list;
    return list;
  }

  // ── Item building ────────────────────────────────────────────────────

  /**
   * Builds the full list of SettingItems for the main settings menu.
   *
   * Includes all scalar settings plus grouped Thresholds and Colors
   * entries that open nested submenus.
   *
   * @param config The current TokenSpeedConfig.
   * @param ctx The command context (for model provider).
   * @param theme The active theme (for colored blocks).
   * @param tui The TUI instance (for submenu dialogs).
   * @returns An array of SettingItems.
   */
  private buildSettingsItems(
    config: TokenSpeedConfig,
    ctx: ExtensionCommandContext,
    theme: Theme,
    tui: TUI,
  ): SettingItem[] {
    const items: SettingItem[] = [];
    for (const [id, setting] of Object.entries(SETTINGS_ITEMS)) {
      const currentValue = setting.format(config);
      if (currentValue === undefined) continue;
      items.push({
        id,
        label: setting.label,
        description: setting.description,
        currentValue,
        ...(setting.values ? { values: setting.values } : {}),
      });
    }

    // Group items — Thresholds and Colors
    const thresholdsItem = SETTINGS_ITEMS["thresholds"];
    if (thresholdsItem) {
      const thresholdsDisplay = Object.values(config.thresholds).join(" | ");
      items.push({
        id: "thresholds",
        label: thresholdsItem.label,
        description: thresholdsItem.description,
        currentValue: thresholdsDisplay,
        submenu: (_currentValue: string, done) => {
          const submenuItems = new TierSubmenuBuilder(
            theme,
            tui,
          ).buildThresholds();
          return this.createSubmenuList(submenuItems, ctx, tui, done);
        },
      });
    }

    const colorsItem = SETTINGS_ITEMS["colors"];
    if (colorsItem) {
      const colorsDisplay = Object.values(config.colors)
        .map((h) => truecolor("■", h))
        .join(" ");
      items.push({
        id: "colors",
        label: colorsItem.label,
        description: colorsItem.description,
        currentValue: colorsDisplay,
        submenu: (_currentValue: string, done) => {
          const submenuItems = new TierSubmenuBuilder(theme, tui).buildColors();
          return this.createSubmenuList(submenuItems, ctx, tui, done);
        },
      });
    }

    return items;
  }

  // ── Refresh helpers ──────────────────────────────────────────────────

  /**
   * Refreshes the appropriate list after a setting change.
   *
   * @param id The setting identifier that changed.
   */
  private refreshListAfterChange(id: string): void {
    if (id.startsWith("thresholds.") || id === "thresholds") {
      this.refreshThresholdItems();
    } else if (id.startsWith("colors.") || id === "colors") {
      this.refreshColorItems();
    }
  }

  /**
   * Refreshes threshold values across the main list, threshold submenu,
   * and active submenu (if thresholds is open).
   */
  private refreshThresholdItems(): void {
    const config = settings.getConfig();
    const { thresholds } = config;
    const allThresholds = TIERS.map(({ key }) => thresholds[key]).join(" | ");

    if (this.settingsList) {
      this.settingsList.updateValue("thresholds", allThresholds);
    }

    if (this.thresholdSubmenuItems) {
      for (const { key } of TIERS) {
        const item = this.thresholdSubmenuItems.find(
          (i) => i.id === `thresholds.${key}`,
        );
        if (item) {
          item.currentValue = thresholds[key].toString();
        }
      }
    }

    if (this.activeSubmenuList) {
      for (const { key } of TIERS) {
        this.activeSubmenuList.updateValue(
          `thresholds.${key}`,
          thresholds[key].toString(),
        );
      }
      this.activeSubmenuList.invalidate();
    }
  }

  /**
   * Refreshes color values across the main list, color submenu,
   * and active submenu (if colors is open).
   */
  private refreshColorItems(): void {
    const config = settings.getConfig();
    const { colors } = config;

    // Update the group row
    if (this.settingsList) {
      this.settingsList.updateValue(
        "colors",
        TIERS.map(({ key }) => truecolor("■", colors[key])).join(" "),
      );
    }

    // Update color submenu items (skip if threshold submenu is open)
    if (!this.thresholdSubmenuItems && this.colorSubmenuItems) {
      for (const { key, label } of TIERS) {
        const item = this.colorSubmenuItems.find(
          (i) => i.id === `colors.${key}`,
        );
        if (item) {
          item.label = `${truecolor("■", colors[key])} ${label}`;
        }
      }
    }

    // Update active submenu
    if (this.activeSubmenuList) {
      for (const { key, label } of TIERS) {
        this.activeSubmenuList.updateValue(`colors.${key}`, colors[key]);
        const internalItems = (
          this.activeSubmenuList as unknown as { items: SettingItem[] }
        ).items;
        if (internalItems) {
          const item = internalItems.find(
            (i: SettingItem) => i.id === `colors.${key}`,
          );
          if (item) {
            item.label = `${truecolor("■", colors[key])} ${label}`;
          }
        }
      }
      this.activeSubmenuList.invalidate();
    }
  }
}
