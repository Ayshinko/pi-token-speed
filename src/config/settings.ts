import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SETTINGS_ITEMS } from "../settings/defaults";
import {
  COLOR_BLAZING,
  COLOR_FAST,
  COLOR_MEDIUM,
  COLOR_SLOW,
} from "../settings/items/colors/color";
import { OverrideValidator } from "../settings/items/override-validator";
import { SettingsRegistry } from "../settings/items/scalar";
import {
  TPS_THRESHOLD_BLAZING,
  TPS_THRESHOLD_FAST,
  TPS_THRESHOLD_MEDIUM,
  TPS_THRESHOLD_SLOW,
} from "../settings/items/thresholds/threshold";
import { STATUS_KEY } from "./constants";
import type {
  PartialConfig,
  ProviderOverride,
  ProviderOverrides,
  TokenSpeedConfig,
} from "./types";

/**
 * Manages TokenSpeed configuration: defaults, user settings, caching,
 * and persistence to ~/.pi/agent/settings.json.
 *
 * Delegates single-field validation to each `SettingItem`'s `check()` method
 * and cross-field validation to standalone functions.
 */
class Settings {
  private cachedConfig: TokenSpeedConfig | null = null;
  private cachedErrors: string[] = [];

  /**
   * @internal Use the exported `settings` singleton instead.
   */
  constructor(
    private readonly settingsPath = join(getAgentDir(), "settings.json"),
  ) {}

  /**
   * Retrieves the default configuration object.
   * Derives scalar defaults from registered `SettingsItem` instances —
   * one source of truth.
   *
   * @returns The default configuration.
   */
  getDefaultConfig(): TokenSpeedConfig {
    const scalars = Object.fromEntries(
      Object.values(SettingsRegistry.ITEMS).map((item) => [
        item.id,
        (item as any).getDefault(),
      ]),
    );
    return {
      thresholds: {
        slow: TPS_THRESHOLD_SLOW,
        medium: TPS_THRESHOLD_MEDIUM,
        fast: TPS_THRESHOLD_FAST,
        blazing: TPS_THRESHOLD_BLAZING,
      },
      colors: {
        slow: COLOR_SLOW,
        medium: COLOR_MEDIUM,
        fast: COLOR_FAST,
        blazing: COLOR_BLAZING,
      },
      providerOverrides: {},
      ...scalars,
    } as TokenSpeedConfig;
  }

  /**
   * Initializes the config by reading the settings file, merging with
   * defaults, and validating. Caches the result for subsequent reads.
   *
   * @returns The resolved and validated TokenSpeedConfig.
   */
  async initialize(): Promise<TokenSpeedConfig> {
    const defaults = this.getDefaultConfig();
    const raw = await this.readUserSettings();

    // Sanitize per-provider overrides: drop malformed entries and invalid
    // keys (collecting prefixed warnings), keeping valid blocks verbatim so
    // resolution via getEffectiveConfig() stays lazy.
    const { overrides: providerOverrides, errors: overrideErrors } =
      this.sanitizeProviderOverrides(raw, defaults);

    const merged = Settings.mergeConfig(defaults, {
      ...raw,
      providerOverrides,
    });

    const { config, errors } = this.validateConfig(merged);
    this.cachedConfig = config;
    this.cachedErrors = [...errors, ...overrideErrors];

    return this.cachedConfig;
  }

  /**
   * Validates the base config, delegating to each SettingItem.
   * Group items (thresholds, colors) act as composites that validate
   * their children.
   */
  validateConfig(config: TokenSpeedConfig): {
    config: TokenSpeedConfig;
    errors: string[];
  } {
    const response = { ...config };
    const errors: string[] = [];

    for (const item of Object.values(SETTINGS_ITEMS)) {
      const result = item.validate(response[item.id as keyof TokenSpeedConfig]);
      if (!result.valid && result.errors) {
        errors.push(...result.errors);
      }
      if (result.corrected !== undefined) {
        (response as any)[item.id] = result.corrected;
      }
    }

    return { config: response, errors };
  }

  /**
   * Returns the effective configuration for a provider: the base config
   * merged with the provider's override block when one exists.
   *
   * Merge semantics (via `mergeConfig`): top-level keys present in the
   * override replace the base value; `thresholds`/`colors` merge per-tier;
   * omitted keys fall back to base.
   *
   * @param providerId The pi ProviderId (e.g. "anthropic"), or undefined
   *   when no model is active — returns the base config.
   */
  getEffectiveConfig(providerId?: string): TokenSpeedConfig {
    const base = this.getConfig();
    if (!providerId) return base;

    const override = base.providerOverrides[providerId];
    if (!override) return base;

    return Settings.mergeConfig(base, override as PartialConfig);
  }

  /**
   * Replaces the whole `providerOverrides` map and updates the cache.
   * Used by the `/tps overrides` editor, whose add/delete semantics are
   * map-level rather than per-key.
   */
  async setProviderOverrides(next: ProviderOverrides): Promise<void> {
    await this.setConfig({ providerOverrides: next });
  }

  /**
   * Returns the cached configuration, or defaults if not yet initialized.
   */
  getConfig(): TokenSpeedConfig {
    return this.cachedConfig || this.getDefaultConfig();
  }

  /**
   * Returns validation errors from the last config resolution.
   * Only relevant at initialization time (e.g., to show warnings).
   */
  getErrors(): string[] {
    return this.cachedErrors;
  }

  /**
   *
   * Writes a partial TokenSpeedConfig and updates the cache.
   *
   * @param partial The partial config to merge and persist.
   */
  async setConfig(partial: PartialConfig): Promise<void> {
    await this.writeUserSettings(partial);
    const current = this.cachedConfig || this.getDefaultConfig();
    this.cachedConfig = Settings.mergeConfig(current, partial);
  }

  /**
   * Shallow-merges two partial configs, merging the nested `thresholds`
   * and `colors` groups per-tier so partials never wipe sibling tiers.
   */
  private static mergeConfig(
    base: PartialConfig,
    partial: PartialConfig,
  ): TokenSpeedConfig {
    // The cast is safe: base is always the full defaults or the cached
    // config, so the merged result is complete at runtime.
    return {
      ...base,
      ...partial,
      thresholds: { ...base.thresholds, ...partial.thresholds },
      colors: { ...base.colors, ...partial.colors },
    } as TokenSpeedConfig;
  }

  /**
   * Safely reads a nested object group (e.g. `thresholds`, `colors`,
   * `tokenSpeed`) from a raw block.
   *
   * @param block The raw settings block to read from.
   * @param group The key of the nested group to extract.
   * @returns A partial object of the group, or an empty object if the
   *   value is missing, null, or an array.
   */
  private readNestedGroup<T extends object>(
    block: Record<string, unknown>,
    group: string,
  ): Partial<T> {
    const value = block[group];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {};
    }
    return value as Partial<T>;
  }

  /**
   * Sanitizes the raw `providerOverrides` value: keeps valid provider →
   * partial-config entries (with invalid keys dropped and warned about),
   * drops malformed entries entirely.
   *
   * @param raw The raw tokenSpeed settings block.
   * @param base The merged base config (defaults + user base settings),
   *   used as the fallback when validating per-tier groups.
   */
  private sanitizeProviderOverrides(
    raw: Record<string, unknown>,
    base: TokenSpeedConfig,
  ): { overrides: ProviderOverrides; errors: string[] } {
    const overrides: ProviderOverrides = {};
    const errors: string[] = [];

    const rawValue = raw.providerOverrides;
    if (rawValue === undefined) return { overrides, errors };

    if (!this.isPlainObject(rawValue)) {
      errors.push("- providerOverrides must be an object — ignoring.");
      return { overrides, errors };
    }

    for (const [providerId, block] of Object.entries(rawValue)) {
      if (!this.isPlainObject(block)) {
        errors.push(
          `- providerOverrides["${providerId}"] must be an object — entry ignored.`,
        );
        continue;
      }
      const { config, errors: blockErrors } = new OverrideValidator(
        providerId,
        base,
      ).validate(block as ProviderOverride);
      errors.push(...blockErrors);
      overrides[providerId] = config;
    }

    return { overrides, errors };
  }

  /**
   * Reads and parses the settings file, returning an empty object on failure.
   *
   * @returns The parsed JSON object, or an empty object if the file is
   *   missing or invalid.
   */
  private async readSettings(): Promise<Record<string, unknown>> {
    try {
      const raw = await readFile(this.settingsPath, "utf-8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /**
   * Writes a JSON object to the settings file with 2-space indentation.
   *
   * @param data The object to serialize and write.
   */
  private async writeSettings(data: Record<string, unknown>): Promise<void> {
    await writeFile(this.settingsPath, JSON.stringify(data, null, 2), "utf-8");
  }

  /**
   * Reads ~/.pi/agent/settings.json and extracts the raw "tokenSpeed" block.
   *
   * @returns The raw TokenSpeed settings object.
   */
  private async readUserSettings(): Promise<Record<string, unknown>> {
    const settings = await this.readSettings();
    return this.readNestedGroup<Record<string, unknown>>(settings, STATUS_KEY);
  }

  /**
   * Writes a partial TokenSpeedConfig to ~/.pi/agent/settings.json,
   * merging it with existing values.
   *
   * Only explicitly-set values are persisted: the partial should contain
   * just the keys/tiers the user changed (nested groups are merged per-tier).
   * Defaults are never written unless the user explicitly sets them.
   *
   * @param partial The partial TokenSpeedConfig to write.
   */
  private async writeUserSettings(partial: PartialConfig): Promise<void> {
    const settings = await this.readSettings();
    const raw =
      this.readNestedGroup<Record<string, unknown>>(settings, STATUS_KEY) || {};

    const block = Settings.mergeConfig(raw as PartialConfig, {
      ...partial,
      thresholds: {
        ...(raw.thresholds as Record<string, unknown>),
        ...partial.thresholds,
      },
      colors: { ...(raw.colors as Record<string, unknown>), ...partial.colors },
    }) as unknown as Record<string, unknown>;

    // Omit empty groups
    if (Object.keys(block.thresholds ?? {}).length === 0) {
      delete block.thresholds;
    }
    if (Object.keys(block.colors ?? {}).length === 0) {
      delete block.colors;
    }
    if (Object.keys(block.providerOverrides ?? {}).length === 0) {
      delete block.providerOverrides;
    }

    if (Object.keys(block).length > 0) {
      settings[STATUS_KEY] = block;
    } else {
      delete settings[STATUS_KEY];
    }
    await this.writeSettings(settings);
  }

  /**
   * Checks whether `value` is a plain object (not null, not array).
   *
   * @param value The value to check.
   * @returns True if value is a plain object.
   */
  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

/**
 * Shared singleton instance used across the extension.
 */
export const settings = new Settings();
