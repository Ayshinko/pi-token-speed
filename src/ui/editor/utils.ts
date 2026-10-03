import { settings } from "../../config/settings";
import type { ProviderOverride, TierName } from "../../config/types";
import { SETTINGS_ITEMS } from "../../settings/defaults";
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
