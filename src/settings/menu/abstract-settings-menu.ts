import type { Theme } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type {
  KeybindingsManager,
  SettingItem,
  SettingsList,
  TUI,
} from "@earendil-works/pi-tui";
import {
  ResettableSettingsList,
  type SettingsListActions,
} from "../../ui/resettable-settings-list";

/**
 * Abstract base for settings menus.
 *
 * Handles common UI concerns: settings list creation, item building,
 * and refresh helpers. No `ExtensionCommandContext`, no engine/renderer.
 */
export abstract class AbstractSettingsMenu {
  /** Currently active submenu SettingsList (colors or thresholds). */
  protected activeSubmenuList: SettingsList | null = null;
  protected colorSubmenuItems: SettingItem[] | null = null;
  protected thresholdSubmenuItems: SettingItem[] | null = null;

  /**
   * Creates a resettable SettingsList for the main settings menu.
   *
   * @param items The settings items to display.
   * @param maxVisible Maximum visible items.
   * @param onChange Callback when a setting changes.
   * @param onCancel Callback when the user cancels/closes the list.
   * @param onReset Callback when a setting is reset.
   * @param tui The TUI instance for re-renders.
   * @param actions Optional add/remove hooks (`a`/`d` keys).
   * @returns A configured SettingsList.
   */
  protected createMainSettingsList(
    items: SettingItem[],
    maxVisible: number,
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
    onReset: (id: string) => void,
    tui: TUI,
    actions?: SettingsListActions,
  ): ResettableSettingsList {
    return new ResettableSettingsList(
      items,
      maxVisible,
      getSettingsListTheme(),
      onChange,
      onCancel,
      onReset,
      tui,
      actions,
    );
  }

  /**
   * Creates a resettable SettingsList for a submenu (colors or thresholds).
   *
   * @param items The submenu items to display.
   * @param maxVisible Maximum visible items.
   * @param onChange Callback when a setting changes.
   * @param onDone Callback when the submenu is closed.
   * @param onReset Callback when a setting is reset.
   * @param tui The TUI instance for re-renders.
   * @returns A configured SettingsList.
   */
  protected createSubmenuList(
    items: SettingItem[],
    maxVisible: number,
    onChange: (id: string, newValue: string) => void,
    onDone: () => void,
    onReset: (id: string) => void,
    tui: TUI,
  ): SettingsList {
    const isThresholds = items.some((i) => i.id.startsWith("thresholds."));
    if (isThresholds) {
      this.thresholdSubmenuItems = items;
    } else {
      this.colorSubmenuItems = items;
    }

    const list = new ResettableSettingsList(
      items,
      maxVisible,
      getSettingsListTheme(),
      onChange,
      () => {
        this.activeSubmenuList = null;
        if (isThresholds) {
          this.thresholdSubmenuItems = null;
        } else {
          this.colorSubmenuItems = null;
        }
        onDone();
      },
      onReset,
      tui,
    );
    this.activeSubmenuList = list;
    return list;
  }

  /**
   * Refreshes the appropriate list after a setting change.
   *
   * @param id The setting identifier that changed.
   */
  protected refreshListAfterChange(id: string): void {
    if (id.startsWith("thresholds.") || id === "thresholds") {
      this.refreshThresholdItems();
    } else if (id.startsWith("colors.") || id === "colors") {
      this.refreshColorItems();
    }
  }

  // ── Template: change flow ─────────────────────────────────────────────

  /**
   * Handles a setting change: delegates persistence to the subclass and
   * then triggers the post-change refresh.
   *
   * @param id The setting identifier.
   * @param value The new value to commit.
   */
  protected async handleSettingChange(
    id: string,
    value: string,
  ): Promise<void> {
    if (!(await this.commit(id, value))) return;
    this.afterChange(id);
  }

  /**
   * Hook called after a successful change. Subclasses override to fire
   * external side effects; the default refreshes the affected lists.
   *
   * @param id The setting identifier that changed.
   */
  protected afterChange(id: string): void {
    this.refreshListAfterChange(id);
  }

  // ── Template: reset flow ──────────────────────────────────────────────

  /**
   * Handles a setting reset: dispatches to the group or scalar hook
   * depending on the id, then triggers the post-reset refresh.
   *
   * @param id The setting identifier.
   */
  protected async resetSetting(id: string): Promise<void> {
    if (id === "thresholds" || id === "colors") {
      await this.resetGroup(id);
    } else {
      await this.resetScalar(id);
    }
    this.afterReset(id);
  }

  /**
   * Hook called after a successful reset. Subclasses override to fire
   * external side effects; the default refreshes the affected lists.
   *
   * @param id The setting identifier that was reset.
   */
  protected afterReset(id: string): void {
    this.refreshListAfterChange(id);
  }

  // ── Subclass hooks ────────────────────────────────────────────────────

  /**
   * Validates and persists a setting change. Field menus override this;
   * container menus (e.g. the provider list) leave it as a no-op.
   *
   * @param id The setting identifier.
   * @param value The new value to commit.
   * @returns Whether the change was committed (false on validation
   *   failure or persistence error — skips the post-change hooks).
   */
  protected commit(_id: string, _value: string): Promise<boolean> {
    return Promise.resolve(true);
  }

  /**
   * Resets a grouped setting (thresholds or colors) as a whole.
   * Field menus override this; container menus leave it as a no-op.
   *
   * @param id The group identifier ("thresholds" or "colors").
   */
  protected resetGroup(_id: string): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Resets a single (scalar or per-tier) setting.
   * Field menus override this; container menus leave it as a no-op.
   *
   * @param id The setting identifier.
   */
  protected resetScalar(_id: string): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Refreshes threshold values across the main list, threshold submenu,
   * and active submenu (if thresholds is open).
   */
  protected refreshThresholdItems(): void {
    // Subclasses override this to update their settingsList
  }

  /**
   * Refreshes color values across the main list, color submenu,
   * and active submenu (if colors is open).
   */
  protected refreshColorItems(): void {
    // Subclasses override this to update their settingsList
  }

  /**
   * Creates the settings list UI.
   *
   * @param tui The TUI instance.
   * @param theme The active theme.
   * @param keybindings The keybindings manager.
   * @param done Callback when the menu is closed.
   * @returns A SettingsList to display.
   */
  abstract create(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (value?: string) => void,
  ): SettingsList;
}
