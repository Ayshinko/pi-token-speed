import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SettingItem, TUI } from "@earendil-works/pi-tui";
import { settings } from "../config/settings";
import { isValidHex } from "../settings/items/tiers/validation";
import { TIERS } from "../settings/options";
import { truecolor } from "./ansi";
import { HexColorInput } from "./color-input";
import { InputDialog } from "./dialog/input-dialog";

/**
 * Builds SettingsList items for tier submenus (colors and thresholds).
 * Each tier opens a framed `InputDialog` for editing on Enter.
 */
export class TierSubmenuBuilder {
  private readonly placeholder: string = "■";

  constructor(
    private readonly theme: Theme,
    private readonly tui: TUI,
  ) {}

  /**
   * Builds the SettingsList items for the color customization submenu.
   *
   * @returns Array of SettingItem for the color submenu.
   */
  buildColors(): SettingItem[] {
    const config = settings.getConfig();

    return TIERS.map((tier) => ({
      id: `colors.${tier.key}`,
      label: `${truecolor(this.placeholder, config.colors[tier.key])} ${tier.label}`,
      description: `Hex color for the ${tier.label.toLowerCase()} tier`,
      currentValue: config.colors[tier.key],
      // Read the config value fresh each time the submenu opens
      // so that previously saved colors are reflected immediately
      submenu: InputDialog.inputSubmenu(this.theme, this.tui, {
        title: `${tier.label} color`,
        message: `Hex color for the ${tier.label.toLowerCase()} tier`,
        placeholder: "#RRGGBB",
        initialValue: config.colors[tier.key],
        // Live hex preview while typing (see PLAN_COLORS.md).
        createInput: () => new HexColorInput(),
        // Normalize on commit: hex is stored lower-cased regardless of
        // how the user typed it (isValidHex accepts both cases).
        validate: (raw) => (isValidHex(raw) ? raw.toLowerCase() : null),
      }),
    }));
  }

  /**
   * Builds the SettingsList items for the TPS threshold customization submenu.
   *
   * @returns Array of SettingItem for the threshold submenu.
   */
  buildThresholds(): SettingItem[] {
    const config = settings.getConfig();

    return TIERS.map((tier) => ({
      id: `thresholds.${tier.key}`,
      label: tier.label,
      description: `TPS threshold for the ${tier.label.toLowerCase()} tier`,
      currentValue: config.thresholds[tier.key].toString(),
      // Read the config value fresh each time the submenu opens
      // so that previously saved thresholds are reflected immediately
      submenu: InputDialog.inputSubmenu(this.theme, this.tui, {
        title: `${tier.label} threshold`,
        message: `TPS threshold for the ${tier.label.toLowerCase()} tier`,
        placeholder: "non-negative integer",
        initialValue: config.thresholds[tier.key].toString(),
        validate: (raw) => {
          const num = Number(raw);
          return Number.isFinite(num) && num >= 0 && Number.isInteger(num)
            ? num.toString()
            : null;
        },
      }),
    }));
  }
}
