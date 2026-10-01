import type { TokenSpeedConfig } from "../../../config/types";
import { SettingsItem } from "../../base";
import { TIERS } from "../../options";

/**
 * Abstract base for per-tier setting items (thresholds and colors).
 *
 * Handles:
 * - `id` = `${prefix}.${tier}`
 * - `format()` — reads from the appropriate config field
 * - `reset(defaults)` — copies the default for this single tier
 */
export abstract class TierSettingsItem extends SettingsItem {
  protected readonly prefix: string;
  protected readonly tier: (typeof TIERS)[number]["key"];

  readonly id: string;

  constructor(prefix: string, tier: (typeof TIERS)[number]["key"]) {
    super();
    this.prefix = prefix;
    this.tier = tier;
    this.id = `${prefix}.${tier}`;
  }

  /**
   * Returns a partial config resetting this tier to its default value.
   *
   * @param defaults The default configuration.
   * @returns A partial config with this tier's default value.
   */
  reset(defaults: TokenSpeedConfig): Partial<TokenSpeedConfig> {
    const group = this.prefix as "thresholds" | "colors";
    const groupVal = defaults[group] as unknown as Record<string, unknown>;
    const val = groupVal[this.tier];
    return { [group]: { [this.tier]: val } } as Partial<TokenSpeedConfig>;
  }
}
