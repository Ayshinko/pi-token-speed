import type { Theme } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type {
  Component,
  Focusable,
  KeybindingsManager,
  SettingsList,
  TUI,
} from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { ProviderOverrides } from "../../config/types";
import { ConfirmDialog } from "../dialog/confirm-dialog";
import { InputDialog } from "../dialog/input-dialog";
import { ResettableSettingsList } from "../resettable-settings-list";
import { ProviderBlockEditor } from "./provider-block-editor";
import { formatOverrideSummary } from "./utils";

/**
 * `/tps overrides` editor — manages the `providerOverrides` map.
 */

/**
 * Shared editor options for the overrides editor.
 */
interface OverridesEditorOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  overrides: ProviderOverrides;
  persist: (next: ProviderOverrides) => Promise<void>;
  done: () => void;
  onError: (message: string) => void;
  onWarning: (message: string) => void;
}

/**
 * Top-level overrides editor: a SettingsList of providers with add/delete
 * support, drilling down into each provider's override block editor.
 */
export class OverridesEditor implements Component, Focusable {
  private settingsList: SettingsList | null = null;
  private mode: "list" | "add" | "confirm" = "list";
  private addDialog: InputDialog | undefined;
  private confirmDialog: ConfirmDialog | undefined;
  private blockEditor: ProviderBlockEditor | null = null;

  private isFocused = false;
  private selectedIndex = 0;
  private submenuOpen = false;

  constructor(private readonly options: OverridesEditorOptions) {
    this.settingsList = this.buildList();
  }

  // -- Persist ------------------------------------------------------------

  private async persistNext(next: ProviderOverrides): Promise<boolean> {
    try {
      await this.options.persist(next);
    } catch (err) {
      this.options.onError(String(err));
      return false;
    }
    Object.keys(this.options.overrides).forEach(
      (k) => delete this.options.overrides[k],
    );
    Object.assign(this.options.overrides, next);
    return true;
  }

  // -- Focusable -----------------------------------------------------------

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    if (this.addDialog) this.addDialog.focused = value;
    if (this.confirmDialog) this.confirmDialog.focused = value;
  }

  // -- Component -----------------------------------------------------------

  invalidate(): void {
    this.settingsList?.invalidate();
    this.addDialog?.invalidate();
    this.confirmDialog?.invalidate();
    this.blockEditor?.invalidate();
  }

  handleInput(data: string): void {
    if (this.mode === "add") return this.addDialog?.handleInput(data);
    if (this.mode === "confirm") return this.confirmDialog?.handleInput(data);

    if (this.submenuOpen && this.blockEditor)
      return this.blockEditor.handleInput(data);

    const kb = this.options.keybindings;
    if (kb.matches(data, "tui.select.cancel")) return this.options.done();

    if (kb.matches(data, "tui.select.up")) {
      this.selectedIndex =
        this.selectedIndex === 0
          ? this.getProviderIds().length - 1
          : this.selectedIndex - 1;
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      this.selectedIndex =
        this.selectedIndex === this.getProviderIds().length - 1
          ? 0
          : this.selectedIndex + 1;
      return;
    }
    if (matchesKey(data, "a")) return this.beginAdd();
    if (matchesKey(data, "d")) return this.beginConfirm();

    if (this.settingsList) this.settingsList.handleInput(data);
  }

  render(width: number): string[] {
    if (this.mode === "add") {
      return this.addDialog?.render(width) ?? [];
    }

    if (this.mode === "confirm") {
      return this.confirmDialog?.render(width) ?? [];
    }

    if (this.settingsList) {
      const lines = this.settingsList.render(width);
      if (this.getProviderIds().length === 0) {
        lines[lines.length - 1] = getSettingsListTheme().hint(
          "Press (a) to add a provider override · Esc to close",
        );
      }
      return lines;
    }
    return ["Loading..."];
  }

  // -- Provider list -------------------------------------------------------

  private getProviderIds(): string[] {
    return Object.keys(this.options.overrides);
  }

  private buildList(): SettingsList {
    this.submenuOpen = false;
    const ids = this.getProviderIds();
    const items: import("@earendil-works/pi-tui").SettingItem[] = ids.map(
      (id, i) => ({
        id: `provider-${i}`,
        label: id,
        description: "(a) add provider · (d) remove provider",
        currentValue: formatOverrideSummary(this.options.overrides[id] ?? {}),
        submenu: (_cv: string, done: (value?: string) => void) => {
          this.submenuOpen = true;
          return this.createBlockList(id, done);
        },
      }),
    );

    return new ResettableSettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      () => {},
      () => this.options.done(),
      (itemId) => {
        const providerId =
          this.getProviderIds()[Number(itemId.slice("provider-".length))];
        if (providerId !== undefined) this.beginReset(providerId);
      },
      this.options.tui,
    );
  }

  private createBlockList(
    providerId: string,
    done: (value?: string) => void,
  ): SettingsList {
    this.blockEditor = new ProviderBlockEditor({
      overrides: this.options.overrides,
      theme: this.options.theme,
      tui: this.options.tui,
      persist: this.options.persist,
      onWarning: this.options.onWarning,
    });

    const onSummaryChanged = () => {
      this.settingsList?.updateValue(
        `provider-${this.getProviderIds().indexOf(providerId)}`,
        formatOverrideSummary(this.options.overrides[providerId] ?? {}),
      );
    };

    return this.blockEditor.create(providerId, onSummaryChanged, done, () => {
      this.submenuOpen = false;
    });
  }

  private rebuildList(targetIndex: number): void {
    this.settingsList = this.buildList();
    const count = this.getProviderIds().length;
    if (count === 0) {
      this.selectedIndex = 0;
      return;
    }
    const target = Math.min(targetIndex, count - 1);
    this.selectedIndex = target;
    this.settingsList.selectItem(`provider-${target}`);
  }

  // -- Add -----------------------------------------------------------------

  private beginAdd(): void {
    this.mode = "add";
    this.addDialog = new InputDialog({
      theme: this.options.theme,
      tui: this.options.tui,
      title: "Add provider override",
      message: 'Provider id to override (e.g. "anthropic")',
      placeholder: "anthropic",
      validate: (raw) => {
        const trimmed = raw.trim();
        return trimmed.length > 0 ? trimmed : null;
      },
      onSubmit: (value) => {
        this.addDialog = undefined;
        this.mode = "list";
        if (this.options.overrides[value] !== undefined) {
          this.options.tui.requestRender();
          return;
        }
        const next: ProviderOverrides = {
          ...this.options.overrides,
          [value]: {},
        };
        void this.persistNext(next).then((ok) => {
          if (ok) {
            this.rebuildList(this.getProviderIds().length - 1);
          }
          this.options.tui.requestRender();
        });
      },
      onCancel: () => {
        this.addDialog = undefined;
        this.mode = "list";
        this.options.tui.requestRender();
      },
    });
    this.addDialog.focused = this.isFocused;
    this.options.tui.requestRender();
  }

  // -- Delete / Reset ------------------------------------------------------

  private beginConfirm(): void {
    const id = this.getProviderIds()[this.selectedIndex];
    if (!id) return;

    this.openConfirmDialog(
      "Delete provider override",
      `Delete overrides for "${id}"?`,
      "Delete",
      () => void this.deleteSelected(),
    );
  }

  private beginReset(providerId: string): void {
    this.openConfirmDialog(
      "Reset provider overrides",
      `Reset all overrides for "${providerId}" to base?`,
      "Reset",
      () => {
        void (async () => {
          const next: ProviderOverrides = {
            ...this.options.overrides,
            [providerId]: {},
          };
          const ok = await this.persistNext(next);
          if (ok) {
            this.rebuildList(this.selectedIndex);
          }
          this.options.tui.requestRender();
        })();
      },
    );
  }

  private openConfirmDialog(
    title: string,
    message: string,
    confirmLabel: string,
    onConfirm: () => void,
  ): void {
    this.mode = "confirm";
    this.confirmDialog = new ConfirmDialog({
      theme: this.options.theme,
      tui: this.options.tui,
      title,
      message,
      confirmLabel,
      onConfirm: () => {
        this.confirmDialog = undefined;
        this.mode = "list";
        onConfirm();
      },
      onCancel: () => {
        this.confirmDialog = undefined;
        this.mode = "list";
        this.options.tui.requestRender();
      },
    });
    this.confirmDialog.focused = this.isFocused;
    this.options.tui.requestRender();
  }

  private async deleteSelected(): Promise<void> {
    const idx = this.selectedIndex;
    const id = this.getProviderIds()[idx];
    if (!id) return;

    const next = { ...this.options.overrides };
    delete next[id];
    const ok = await this.persistNext(next);
    if (ok) {
      this.rebuildList(idx);
    }
    this.options.tui.requestRender();
  }
}
