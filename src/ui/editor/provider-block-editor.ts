import type { Theme } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { Component, Input, TUI } from "@earendil-works/pi-tui";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { settings } from "../../config/settings";
import type {
  ProviderOverride,
  ProviderOverrides,
  TierName,
} from "../../config/types";
import { SETTINGS_ITEMS } from "../../settings/defaults";
import { isValidHex } from "../../settings/items/tiers/validation";
import { TIERS } from "../../settings/options";
import { truecolor } from "../ansi";
import { HexColorInput } from "../color-input";
import { InputDialog } from "../dialog/input-dialog";
import { ResettableSettingsList } from "../resettable-settings-list";
import { BASE, computeNextBlock, fieldValue } from "./utils";

/** Callback for when the block summary needs refreshing. */
type SummaryChangedCallback = () => void;

/** Callback for when the block editor closes. */
type CloseCallback = () => void;

/** Per-tier params returned by @see TierSubmenuOptions.itemFactory. */
type TierSubmenuParams = {
  description: string;
  currentValue: string;
  initialValue: string;
  placeholder: string;
  createInput?: () => Input;
  validate: (raw: string) => string | null;
  label?: string;
};

/** @see TierSubmenuOptions.baseValue */
type TierBaseValueFn = (
  base: ReturnType<typeof settings.getConfig>,
  tier: (typeof TIERS)[number],
) => string;

/** @see TierSubmenuOptions.titleFor @see TierSubmenuOptions.messageFor */
type TierLabelFn = (tier: (typeof TIERS)[number]) => string;

/** Params for @see ProviderBlockEditor.buildTierSubmenu. */
type TierSubmenuOptions = {
  id: string;
  label: string;
  description: string;
  getBlock: () => ProviderOverride;
  base: ReturnType<typeof settings.getConfig>;
  itemFactory: (
    base: ReturnType<typeof settings.getConfig>,
    tier: (typeof TIERS)[number],
  ) => TierSubmenuParams;
  baseValue: TierBaseValueFn;
  titleFor: TierLabelFn;
  messageFor: TierLabelFn;
};

/**
 * Context needed by the block editor to operate.
 */
interface BlockEditorContext {
  overrides: ProviderOverrides;
  theme: Theme;
  tui: TUI;
  persist: (next: ProviderOverrides) => Promise<void>;
  onWarning: (message: string) => void;
}

/**
 * Editor for a single provider's override block.
 *
 * Handles building the SettingsList of fields, committing changes,
 * resetting fields, and refreshing row values.
 */
export class ProviderBlockEditor implements Component {
  private list: SettingsList | null = null;
  private providerId: string | null = null;
  private onSummaryChanged: SummaryChangedCallback | null = null;
  private onDone: CloseCallback | null = null;
  private onClose: CloseCallback | null = null;
  private nested: {
    thresholds: SettingItem[] | null;
    colors: SettingItem[] | null;
  } = { thresholds: null, colors: null };

  constructor(private readonly ctx: BlockEditorContext) {}

  /**
   * Creates the field SettingsList for this provider's override block.
   */
  create(
    providerId: string,
    onSummaryChanged: SummaryChangedCallback,
    onDone: CloseCallback,
    onClose: CloseCallback,
  ): SettingsList {
    this.providerId = providerId;
    this.onSummaryChanged = onSummaryChanged;
    this.onDone = onDone;
    this.onClose = onClose;
    this.nested = { thresholds: null, colors: null };

    const items = this.buildBlockItems(
      () => this.ctx.overrides[providerId] ?? {},
    );

    this.list = new ResettableSettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      this.commit.bind(this),
      () => {
        this.onClose?.();
        this.onDone?.();
      },
      (id) => this.resetField(id),
      this.ctx.tui,
    );

    return this.list;
  }

  // -- Component -----------------------------------------------------------

  invalidate(): void {
    this.list?.invalidate();
  }

  handleInput(data: string): void {
    this.list?.handleInput(data);
  }

  render(width: number): string[] {
    return this.list?.render(width) ?? [];
  }

  // -- Commit --------------------------------------------------------------

  /**
   * Commits a field change: computes the next block and applies it.
   */
  private commit(id: string, value: string): void {
    const providerId = this.providerId!;
    const current = this.ctx.overrides[providerId] ?? {};
    const nextBlock = computeNextBlock(current, id, value, this.ctx.onWarning);
    if (nextBlock === null) return;

    const next: ProviderOverrides = {
      ...this.ctx.overrides,
      [providerId]: nextBlock,
    };

    void (async () => {
      try {
        await this.ctx.persist(next);
      } catch {
        return;
      }
      this.ctx.overrides = next;
      this.refresh(nextBlock);
      this.onSummaryChanged?.();
      this.ctx.tui.requestRender();
    })();
  }

  // -- Refresh -------------------------------------------------------------

  /**
   * Refreshes every row's currentValue from the adopted block.
   */
  refresh(block: ProviderOverride): void {
    const base = settings.getConfig();
    const items = this.buildBlockItems(() => block);

    for (const item of items) {
      item.currentValue = fieldValue(item.id, block);
    }

    if (this.nested.thresholds) {
      for (const item of this.nested.thresholds) {
        const tier = item.id.slice("thresholds.".length) as TierName;
        item.currentValue = block.thresholds?.[tier]?.toString() ?? BASE;
      }
    }

    if (this.nested.colors) {
      for (const item of this.nested.colors) {
        const tier = item.id.slice("colors.".length) as TierName;
        const hex = block.colors?.[tier] ?? base.colors[tier];
        const label = TIERS.find((t) => t.key === tier)?.label ?? tier;
        item.label = `${truecolor("■", hex)} ${label}`;
        item.currentValue = block.colors?.[tier] ?? BASE;
      }
    }
    this.ctx.tui.requestRender();
  }

  // -- Reset ---------------------------------------------------------------

  private resetField(id: string): void {
    if (id === "thresholds" || id === "colors") {
      const providerId = this.providerId!;
      const current = this.ctx.overrides[providerId] ?? {};
      const nextBlock = { ...current };
      delete nextBlock[id];
      this.commitFromBlock(nextBlock);
      return;
    }

    const value =
      id.startsWith("thresholds.") || id.startsWith("colors.") ? "" : BASE;
    this.commit(id, value);
  }

  /**
   * Applies a block change directly (bypasses computeNextBlock).
   * Used by resetField for group-level resets.
   */
  private commitFromBlock(nextBlock: ProviderOverride): void {
    const providerId = this.providerId!;
    const next: ProviderOverrides = {
      ...this.ctx.overrides,
      [providerId]: nextBlock,
    };

    void (async () => {
      try {
        await this.ctx.persist(next);
      } catch {
        return;
      }
      this.ctx.overrides = next;
      this.refresh(nextBlock);
      this.onSummaryChanged?.();
      this.ctx.tui.requestRender();
    })();
  }

  // -- Block items ---------------------------------------------------------

  private buildBlockItems(getBlock: () => ProviderOverride): SettingItem[] {
    const base = settings.getConfig();

    // Scalar settings (excludes grouped thresholds/colors)
    const scalarItems = Object.values(SETTINGS_ITEMS).filter(
      (item) =>
        !item.id.startsWith("thresholds") && !item.id.startsWith("colors"),
    );

    const getBlock_ = getBlock();

    // Scalar items
    const items: SettingItem[] = scalarItems.map((item) => {
      const hasField = item.id in getBlock_;
      return {
        id: item.id,
        label: item.label,
        description: `Base: ${item.formatPartial({}, base)}`,
        currentValue: hasField
          ? (item.formatPartial(getBlock_, base) ?? BASE)
          : BASE,
        values: [BASE, ...(item.values ?? [])],
      };
    });

    // Thresholds submenu
    const thresholdsSubmenu = this.buildTierSubmenu({
      id: "thresholds",
      label: "Thresholds",
      description:
        "Customize TPS threshold overrides (slow, medium, fast, blazing)",
      getBlock: () => getBlock_,
      base,
      itemFactory: (base, tier) => ({
        description: `TPS threshold override for the ${tier.label.toLowerCase()} tier (Base: ${base.thresholds[tier.key]})`,
        currentValue: fieldValue(`thresholds.${tier.key}`, getBlock()),
        initialValue: getBlock().thresholds?.[tier.key]?.toString() ?? "",
        placeholder: "non-negative integer",
        createInput: undefined,
        validate: (raw: string) => {
          const trimmed = raw.trim();
          if (trimmed === "") return "";
          const n = Number(trimmed);
          return Number.isInteger(n) && n >= 0 ? n.toString() : null;
        },
      }),
      baseValue: (base, tier) => String(base.thresholds[tier.key]),
      titleFor: (tier) => `${tier.label} threshold override`,
      messageFor: (tier) =>
        `TPS threshold for the ${tier.label.toLowerCase()} tier`,
    });

    // Colors submenu
    const colorsSubmenu = this.buildTierSubmenu({
      id: "colors",
      label: "Colors",
      description:
        "Customize tier color overrides (slow, medium, fast, blazing)",
      getBlock,
      base,
      itemFactory: (base, tier) => {
        const hex = getBlock().colors?.[tier.key] ?? base.colors[tier.key];
        return {
          description: `Hex color override for the ${tier.label.toLowerCase()} tier (Base: ${base.colors[tier.key]})`,
          currentValue: fieldValue(`colors.${tier.key}`, getBlock()),
          initialValue: getBlock().colors?.[tier.key] ?? "",
          placeholder: "#RRGGBB",
          createInput: () => new HexColorInput(),
          validate: (raw: string) => {
            const trimmed = raw.trim();
            if (trimmed === "") return "";
            return isValidHex(trimmed) ? trimmed.toLowerCase() : null;
          },
          label: `${truecolor("■", hex)} ${tier.label}`,
        };
      },
      baseValue: (base, tier) => base.colors[tier.key],
      titleFor: (tier) => `${tier.label} color override`,
      messageFor: (tier) =>
        `Hex color for the ${tier.label.toLowerCase()} tier`,
    });

    items.push(thresholdsSubmenu);
    items.push(colorsSubmenu);

    return items;
  }

  /**
   * Builds a grouped SettingItem with a tier-based submenu.
   * Shared between thresholds and colors rows.
   *
   * @param opts - The submenu configuration.
   * @returns A SettingItem with a nested tier-based submenu.
   */
  private buildTierSubmenu(opts: TierSubmenuOptions): SettingItem {
    return {
      id: opts.id,
      label: opts.label,
      description: opts.description,
      currentValue: fieldValue(opts.id, opts.getBlock()),
      submenu: (
        _currentValue: string,
        submenuDone: (value?: string) => void,
      ) => {
        const tierItems = TIERS.map((tier) => {
          const params = opts.itemFactory(opts.base, tier);
          return {
            id: `${opts.id}.${tier.key}`,
            label: params.label ?? tier.label,
            description: params.description,
            currentValue: params.currentValue,
            submenu: InputDialog.inputSubmenu(this.ctx.theme, this.ctx.tui, {
              title: opts.titleFor(tier),
              message: `${opts.messageFor(tier)} (empty = reset to base: ${opts.baseValue(opts.base, tier)})`,
              placeholder: params.placeholder,
              initialValue: params.initialValue,
              createInput: params.createInput,
              validate: params.validate,
            }),
          };
        });
        this.nested[opts.id as "thresholds" | "colors"] = tierItems;
        return new ResettableSettingsList(
          tierItems,
          Math.min(tierItems.length + 2, 15),
          getSettingsListTheme(),
          this.commit.bind(this),
          () => submenuDone(undefined),
          (nestedId) => this.commit(nestedId, ""),
          this.ctx.tui,
        );
      },
    };
  }
}
