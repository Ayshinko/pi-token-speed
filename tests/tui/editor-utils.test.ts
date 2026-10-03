import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderOverride } from "../../src/config/types";
import { fieldValue } from "../../src/ui/editor/utils";

// ── Mock settings ──────────────────────────────────────────────────────────

const settingsState = vi.hoisted(() => {
  const makeDefaults = () => ({
    display: "tps" as const,
    slidingWindow: 5000,
    useProviderTokens: false,
    countStrategy: "direct" as const,
    endTpsBehavior: "average" as const,
    icon: "⚡",
    updateInterval: 0,
    thresholds: { slow: 10, medium: 30, fast: 60, blazing: 100 },
    colors: {
      slow: "#ffcc00",
      medium: "#88cc00",
      fast: "#44cc44",
      blazing: "#00ccff",
    },
    displayColors: { count: "#111111", elapsed: "#222222", ttft: "#333333" },
    providerOverrides: {},
  });
  let current: ReturnType<typeof makeDefaults> = makeDefaults();
  return {
    makeDefaults,
    get config() {
      return current;
    },
    set config(value: ReturnType<typeof makeDefaults>) {
      current = value;
    },
  };
});

vi.mock("../../src/config/settings", () => ({
  settings: {
    getConfig: vi.fn(() => settingsState.config),
    getDefaultConfig: vi.fn(() => settingsState.makeDefaults()),
    setConfig: vi.fn(),
  },
}));

// ── Tests ────────────────────────────────────────────────────────────────────

describe("fieldValue", () => {
  beforeEach(() => {
    settingsState.config = settingsState.makeDefaults();
  });

  describe("scalar fields", () => {
    it("returns BASE when the field is not overridden", () => {
      expect(fieldValue("display", {})).toBe("(base)");
    });

    it("returns the formatted override when set", () => {
      expect(fieldValue("updateInterval", { updateInterval: 250 })).toBe("250");
    });
  });

  describe("thresholds group row", () => {
    it("shows (base) for every tier when nothing is overridden", () => {
      expect(fieldValue("thresholds", {})).toBe(
        "(base) | (base) | (base) | (base)",
      );
    });

    it("shows the override value for set tiers and (base) for the rest", () => {
      const block: ProviderOverride = {
        thresholds: { medium: 25 },
      };
      expect(fieldValue("thresholds", block)).toBe(
        "(base) | 25 | (base) | (base)",
      );
    });

    it("resolves tier children to (base) or the override", () => {
      const block: ProviderOverride = {
        thresholds: { fast: 90 },
      };
      expect(fieldValue("thresholds.fast", block)).toBe("90");
      expect(fieldValue("thresholds.slow", block)).toBe("(base)");
    });
  });

  describe("colors group row", () => {
    it("renders one square per tier using the base colors", () => {
      const value = fieldValue("colors", {});
      expect(value.split("■").length - 1).toBe(4);
      expect(value).toContain("\x1b[38;2;255;204;0m"); // #ffcc00
      expect(value).toContain("\x1b[38;2;0;204;255m"); // #00ccff
    });

    it("renders the override color for set tiers", () => {
      const block: ProviderOverride = {
        colors: { medium: "#ff00ff" },
      };
      const value = fieldValue("colors", block);
      expect(value).toContain("\x1b[38;2;255;0;255m"); // #ff00ff
      expect(value).toContain("\x1b[38;2;255;204;0m"); // base slow
    });
  });

  describe("displayColors group row", () => {
    it("renders one square per key using the base colors", () => {
      const value = fieldValue("displayColors", {});
      expect(value.split("■").length - 1).toBe(3);
      expect(value).toContain("\x1b[38;2;17;17;17m"); // #111111
    });

    it("renders the override color for set keys", () => {
      const block: ProviderOverride = {
        displayColors: { ttft: "#abcDEF" },
      };
      const value = fieldValue("displayColors", block);
      expect(value).toContain("\x1b[38;2;171;205;239m"); // #abcdef
    });
  });
});
