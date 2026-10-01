import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { TokenSpeedEngine } from "../core/engine";
import { SettingsMenu } from "../settings/menu";
import type { Renderer } from "../ui/renderer";

/**
 * Thin command router — dispatches `/tps` arguments to the appropriate handler.
 * All UI/ctx concerns are delegated to `SettingsMenu`.
 */
export class CommandManager {
  private readonly settingsMenu: SettingsMenu;

  constructor(renderer: Renderer, engine: TokenSpeedEngine) {
    this.settingsMenu = new SettingsMenu(renderer, engine);
  }

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
      await this.settingsMenu.showOverridesEditor(ctx);
      return;
    }

    if (args === "") {
      await this.settingsMenu.showSettingsMenu(ctx);
      return;
    }

    ctx.ui.notify(
      `Unknown argument "${args}" — usage: /tps [overrides]`,
      "warning",
    );
  }
}
