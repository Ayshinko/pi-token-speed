import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { settings } from "../config/settings";
import type { TokenSpeedEngine } from "../core/engine";
import { OverrideSettingsMenu } from "../settings/menu/override-settings-menu";
import { SettingsMenu } from "../settings/menu/settings-menu";
import type { Renderer } from "../ui/renderer";

/**
 * Thin command router — dispatches `/tps` arguments to the appropriate handler.
 * All UI/ctx concerns are owned here; menu classes are pure UI components.
 */
export class CommandManager {
  constructor(
    private readonly renderer: Renderer,
    private readonly engine: TokenSpeedEngine,
  ) {}

  /**
   * Argument completions for the `/tps` command.
   */
  getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
    const completions: AutocompleteItem[] = [
      {
        value: "overrides",
        label: "overrides",
        description: "Manage per-provider overrides",
      },
    ];
    const filtered = completions.filter((a) => a.value.startsWith(prefix));
    return filtered.length > 0 ? filtered : null;
  }

  /**
   * Handles the `/tps` command.
   *
   * - No arguments: opens the settings menu.
   * - `overrides`: opens the per-provider overrides editor.
   *
   * @param args Command arguments
   * @param ctx The command context
   */
  async runTps(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (args === "overrides") {
      const overrides = settings.getConfig().providerOverrides;
      const menu = new OverrideSettingsMenu({
        overrides: { ...overrides },
        persist: (next) => settings.setProviderOverrides(next),
        onSettingChange: () => {
          this.engine.initialize();
          this.engine.applyProvider(ctx.model?.provider);
          this.renderer.update(ctx);
        },
        onError: (message) => ctx.ui.notify(message, "error"),
      });
      await ctx.ui.custom<void>((tui, theme, kb, done) =>
        menu.create(tui, theme, kb, () => done(undefined)),
      );
      return;
    }

    if (args === "") {
      const menu = new SettingsMenu({
        config: settings.getConfig(),
        onSettingChange: () => {
          this.engine.initialize();
          this.renderer.update(ctx);
        },
      });
      await ctx.ui.custom<void>((tui, theme, kb, done) =>
        menu.create(tui, theme, kb, () => done(undefined)),
      );
      return;
    }

    ctx.ui.notify(
      `Unknown argument "${args}" — usage: /tps [overrides]`,
      "warning",
    );
  }
}
