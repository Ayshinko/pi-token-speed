import type {
  Colors,
  ProviderOverride,
  Thresholds,
  TierName,
  TokenSpeedConfig,
} from "../../config/types";
import { SETTINGS_ITEMS } from "../defaults";
import { COLOR_ITEMS } from "./colors";
import { THRESHOLD_ITEMS } from "./thresholds";
import { isAscendingThresholds, isValidHex } from "./tiers/validation";

/**
 * Validates a provider override block against a base config.
 *
 * Scalar keys are validated via their SettingItem.validate() and dropped
 * if invalid. Thresholds/colors are validated per-tier (dropping invalid
 * tiers), then cross-field validated against the merged (base + override)
 * values so an override can't create an invalid ordering via fallback.
 */
export class OverrideValidator {
  constructor(
    private readonly providerId: string,
    private readonly base: TokenSpeedConfig,
  ) {}

  /**
   * Validates a provider override block, cleaning invalid entries and
   * collecting errors. Scalar keys delegate to SettingItem.validate();
   * thresholds/colors are validated per-tier and cross-field against merged values.
   *
   * @param override The override block to validate.
   * @returns The cleaned override and an array of validation error messages.
   */
  validate(override: ProviderOverride): {
    config: ProviderOverride;
    errors: string[];
  } {
    const cleaned: ProviderOverride = { ...override };
    const errors: string[] = [];
    const drop = (key: string, detail: string) => {
      errors.push(
        `- providerOverrides["${this.providerId}"]: ${detail} — falling back to base.`,
      );
      delete cleaned[key as keyof ProviderOverride];
    };

    this.validateScalars(cleaned, errors, drop);
    this.validateThresholds(cleaned, errors, drop);
    this.validateColors(cleaned, errors, drop);

    return { config: cleaned, errors };
  }

  /** Scalar keys: delegate to each SettingItem's validate() (skip composites). */
  private validateScalars(
    cleaned: ProviderOverride,
    errors: string[],
    drop: (key: string, detail: string) => void,
  ): void {
    for (const item of Object.values(SETTINGS_ITEMS)) {
      if (
        item.id in cleaned &&
        item.id !== "thresholds" &&
        item.id !== "colors"
      ) {
        const result = item.validate(
          cleaned[item.id as keyof ProviderOverride],
        );
        if (!result.valid) {
          drop(item.id, result.errors?.[0] ?? `Invalid ${item.id}`);
        }
      }
    }
  }

  /** Thresholds: keep only valid tiers, then validate ordering against merged. */
  private validateThresholds(
    cleaned: ProviderOverride,
    errors: string[],
    drop: (key: string, detail: string) => void,
  ): void {
    if (cleaned.thresholds === undefined) return;
    const raw = cleaned.thresholds;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      drop("thresholds", "Invalid thresholds (expected object)");
      return;
    }

    const partial: Partial<Thresholds> = {};
    for (const [tier, value] of Object.entries(raw)) {
      const tierItem = THRESHOLD_ITEMS[tier as TierName];
      if (tierItem) {
        const result = tierItem.validate(value);
        if (result.valid) {
          partial[tier as TierName] = value as number;
        } else {
          errors.push(
            `- providerOverrides["${this.providerId}"]: Invalid thresholds.${tier} "${value}" (expected number) — tier falls back to base.`,
          );
        }
      } else {
        errors.push(
          `- providerOverrides["${this.providerId}"]: Invalid thresholds.${tier} "${value}" (unknown tier) — tier falls back to base.`,
        );
      }
    }

    const merged = { ...this.base.thresholds, ...partial };
    if (!isAscendingThresholds(merged)) {
      drop(
        "thresholds",
        `Thresholds must be in ascending order (effective: ${merged.slow} < ${merged.medium} < ${merged.fast} < ${merged.blazing})`,
      );
    } else if (Object.keys(partial).length > 0) {
      cleaned.thresholds = partial;
    } else {
      delete cleaned.thresholds;
    }
  }

  /** Colors: keep only valid tiers, then validate all merged values are hex. */
  private validateColors(
    cleaned: ProviderOverride,
    errors: string[],
    drop: (key: string, detail: string) => void,
  ): void {
    if (cleaned.colors === undefined) return;
    const raw = cleaned.colors;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      drop("colors", "Invalid colors (expected object)");
      return;
    }

    const partial: Partial<Colors> = {};
    for (const [tier, value] of Object.entries(raw)) {
      const tierItem = COLOR_ITEMS[tier as TierName];
      if (tierItem) {
        const result = tierItem.validate(value);
        if (result.valid) {
          partial[tier as TierName] = value.toLowerCase() as Colors[TierName];
        } else {
          errors.push(
            `- providerOverrides["${this.providerId}"]: Invalid colors.${tier} "${value}" (expected hex like '#00ff88') — tier falls back to base.`,
          );
        }
      } else {
        errors.push(
          `- providerOverrides["${this.providerId}"]: Invalid colors.${tier} "${value}" (unknown tier) — tier falls back to base.`,
        );
      }
    }

    const merged = { ...this.base.colors, ...partial };
    const allValid = Object.values(merged).every((c) => isValidHex(c));
    if (!allValid) {
      drop("colors", "Effective colors must be valid hex strings");
    } else if (Object.keys(partial).length > 0) {
      cleaned.colors = partial;
    } else {
      delete cleaned.colors;
    }
  }
}
