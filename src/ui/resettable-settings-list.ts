import type { TUI } from "@earendil-works/pi-tui";
import {
  SettingsList,
  truncateToWidth,
  type SettingItem,
  type SettingsListTheme,
} from "@earendil-works/pi-tui";

/**
 * SettingsList with an `r` shortcut: "return to default" for the
 * selected row. What a reset means (drop an override key, restore a
 * built-in default, …) is decided by the `onReset` callback.
 *
 * The base class ignores unrecognized keys and delegates all input to
 * the active submenu when one is open, so `r` only triggers a reset on
 * the main list: nested lists (which reset on their own `r`) and text
 * inputs (which need the letter) are never affected.
 */
export class ResettableSettingsList extends SettingsList {
  /** Saved for re-rendering the advertised hint line in `render`. */
  private readonly hintTheme: SettingsListTheme;
  /** TUI instance for post-reset re-render. */
  private readonly tui: TUI;

  constructor(
    items: SettingItem[],
    maxVisible: number,
    theme: SettingsListTheme,
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
    onReset: (id: string) => void,
    tui: TUI,
  ) {
    super(items, maxVisible, theme, onChange, onCancel);
    this.hintTheme = theme;
    this.tui = tui;
    this.onReset = onReset;
  }

  /** The reset callback (stored for the handleInput override). */
  private onReset: (id: string) => void;

  override handleInput(data: string): void {
    if (data === "r" && !this.hasOpenSubmenu()) {
      const item = this.getSelectedItem();
      if (item) {
        this.onReset(item.id);
        this.tui.requestRender();
        return;
      }
    }
    super.handleInput(data);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    // Advertise the shortcut in the standard hint line (the base class
    // renders it last whenever the list is non-empty)
    const last = lines[lines.length - 1];
    if (last !== undefined && last.includes("Esc to cancel")) {
      lines[lines.length - 1] = truncateToWidth(
        this.hintTheme.hint(
          "  Enter/Space to change · r reset to default · Esc to cancel",
        ),
        width,
      );
    }
    return lines;
  }

  /**
   * `items`/`selectedIndex`/`submenuComponent` are private in the base
   * class (with no public accessor); bracket access keeps this subclass
   * compilable against them.
   */
  private hasOpenSubmenu(): boolean {
    return this["submenuComponent"] != null;
  }

  private getSelectedItem(): SettingItem | undefined {
    return this["getDisplayItems"]()[this["selectedIndex"]];
  }
}
