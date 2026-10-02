import { settings } from "../../config/settings";
import type {
  ProviderOverride,
  Thresholds,
  TierName,
} from "../../config/types";
import { SETTINGS_ITEMS } from "../../settings/defaults";
import { isAscendingThresholds } from "../../settings/items/tiers/validation";
import { TIERS } from "../../settings/options";
import { truecolor } from "../ansi";

/** Label shown for fields not set in the override block. */
export const BASE = "(base)";

/**
 * Computes the currentValue shown for a block field row.
 */
export function fieldValue(id: string, block: ProviderOverride): string {
  const item = SETTINGS_ITEMS[id];
  if (item && !id.startsWith("thresholds") && !id.startsWith("colors")) {
    return id in block
      ? (item.formatPartial(block, settings.getConfig()) ?? BASE)
      : BASE;
  }
  if (id === "thresholds") {
    return TIERS.map((t) => block.thresholds?.[t.key]?.toString() ?? BASE).join(
      " | ",
    );
  }
  if (id === "colors") {
    const base = settings.getConfig();
    return TIERS.map((t) =>
      truecolor("■", block.colors?.[t.key] ?? base.colors[t.key]),
    ).join(" ");
  }
  if (id.startsWith("thresholds.")) {
    const tier = id.slice("thresholds.".length) as TierName;
    return block.thresholds?.[tier]?.toString() ?? BASE;
  }
  if (id.startsWith("colors.")) {
    const tier = id.slice("colors.".length) as TierName;
    return block.colors?.[tier] ?? BASE;
  }
  return "";
}

type WarningCallback = (message: string) => void;

/**
 * Computes the next block after a field change. Invalid values return
 * `null` (the warning has already been notified by the caller).
 * Empty input on input-dialog fields means "reset to base" (key removed).
 */
export function computeNextBlock(
  block: ProviderOverride,
  id: string,
  value: string,
  onWarning?: WarningCallback,
): ProviderOverride | null {
  const next: ProviderOverride = { ...block };
  const base = settings.getConfig();

  // Scalar fields delegate to SettingsItem
  const item = SETTINGS_ITEMS[id];
  if (item && !id.startsWith("thresholds") && !id.startsWith("colors")) {
    if (value === BASE) {
      delete next[id as keyof ProviderOverride];
      return next;
    }
    const result = item.setConfigPartial(block, base, value);
    if (!result.valid) return null;
    if (result.config) Object.assign(next, result.config);
    return next;
  }

  if (id.startsWith("thresholds.")) {
    const tier = id.slice("thresholds.".length) as TierName;
    const thresholds: Partial<Thresholds> = { ...(block.thresholds ?? {}) };
    if (value === "") {
      delete thresholds[tier];
    } else {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) return null;
      thresholds[tier] = n;
    }
    if (Object.keys(thresholds).length > 0) {
      const merged = { ...base.thresholds, ...thresholds };
      if (!isAscendingThresholds(merged)) {
        onWarning?.("[pi-token-speed] Thresholds must be in ascending order.");
        return null;
      }
      next.thresholds = thresholds;
    } else {
      delete next.thresholds;
    }
    return next;
  }

  if (id.startsWith("colors.")) {
    const tier = id.slice("colors.".length) as TierName;
    const colors = { ...(block.colors ?? {}) };
    if (value === "") {
      delete colors[tier];
    } else {
      colors[tier] = value.toLowerCase();
    }
    if (Object.keys(colors).length > 0) next.colors = colors;
    else delete next.colors;
    return next;
  }

  return null;
}
