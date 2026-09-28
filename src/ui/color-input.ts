import { Input, visibleWidth } from "@earendil-works/pi-tui";
import { Validator } from "../config/validation";

/** Maximum length for a hex color string (#RRGGBB = 7 chars). */
const MAX_HEX_LENGTH = 7;

/**
 * Returns true when `data` consists solely of characters valid for a hex
 * color input (`#` and `0-9A-Fa-f`).  Returns false for control sequences,
 * escape keys, or any non-hex printable characters — these are always
 * passed through to the parent so navigation, deletion, undo, paste, etc.
 * continue to work normally.
 */
function isHexCharacterInsert(data: string): boolean {
  // Control sequences (arrow keys, function keys, bracketed paste, etc.)
  if (data.startsWith("\x1b")) return false;
  // Control characters (C0, DEL, C1)
  if (
    [...data].some((ch) => {
      const code = ch.charCodeAt(0);
      return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    })
  )
    return false;
  // Must be only valid hex color characters
  return /^[#0-9A-Fa-f]+$/.test(data);
}

/**
 * Single-line input that live-previews hex color values: the moment the
 * typed value forms a valid `#RRGGBB` string, the text (including the
 * leading `#`) is rendered in that color — no Enter required.
 *
 * pi-tui's `Input` renders its value unstyled (its only styling hook,
 * `placeholderStyle`, applies solely to the empty-state placeholder), so
 * this subclass post-processes the rendered line: a 24-bit truecolor fg
 * escape is injected right after the prompt and reset before the trailing
 * padding. The only escapes inside the value region are the zero-width
 * `CURSOR_MARKER` and the reverse-video cursor pair (`\x1b[7m…\x1b[27m`),
 * both of which compose fine with an fg color — as a bonus, the cursor
 * block shows the chosen color as its background.
 *
 * Degradation: if pi-tui ever changes the render layout
 * (`prompt + text + padding`), this subclass degrades to "no preview",
 * not to breakage.
 */
export class HexColorInput extends Input {
  private readonly promptText: string;

  constructor(options?: { prompt?: string }) {
    super(options);
    // Kept locally because `Input`'s `prompt` field is private and the
    // rendered-line splicing below needs its plain-text extent. Note:
    // the prompt must be a plain (escape-free) string for this to work.
    this.promptText = options?.prompt ?? "> ";
  }

  /**
   * Override to restrict input to valid hex color characters (`#` and
   * `0-9A-Fa-f`) and enforce a maximum of 7 characters.  Navigation,
   * deletion, undo, paste, and other editor commands pass through
   * (the parent class handles keybindings before rejecting stray
   * control characters).
   */
  override handleInput(data: string): void {
    // Escape sequences: always pass through (arrow keys, function keys, etc.)
    if (data.startsWith("\x1b")) {
      super.handleInput(data);
      return;
    }
    // Control characters (C0, DEL, C1): pass through (parent handles
    // keybindings like backspace/delete, then ignores stray chars)
    if (
      [...data].some((ch) => {
        const code = ch.charCodeAt(0);
        return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
      })
    ) {
      super.handleInput(data);
      return;
    }
    // Printable characters: validate and limit
    if (!isHexCharacterInsert(data)) return; // reject non-hex
    if (this.getValue().length >= MAX_HEX_LENGTH) return; // reject over limit
    super.handleInput(data);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const value = this.getValue();
    if (!Validator.isValidHex(value)) return lines;

    // A valid hex is always 7 ASCII chars, so the value can only be
    // horizontally scrolled when the available width can't show all 7
    // chars. Skip colorization in that case rather than splicing escapes
    // into a scrolled/clipped render (equivalent to pi-tui's private
    // `renderedStartColumn === 0` check, without touching private state).
    if (visibleWidth(this.promptText) + value.length > width) return lines;

    const line = lines[0];
    const r = parseInt(value.slice(1, 3), 16);
    const g = parseInt(value.slice(3, 5), 16);
    const b = parseInt(value.slice(5, 7), 16);
    const fg = `\x1b[38;2;${r};${g};${b}m`;

    // The line is `prompt + textWithCursor + padding`, where the padding is
    // a trailing run of spaces. The value region itself never ends with a
    // raw space (a cursor parked at the end is wrapped in `\x1b[27m`), so
    // scanning back over spaces reliably finds the end of the text region.
    let textEnd = line.length;
    while (textEnd > this.promptText.length && line[textEnd - 1] === " ") {
      textEnd--;
    }

    return [
      line.slice(0, this.promptText.length) +
        fg +
        line.slice(this.promptText.length, textEnd) +
        "\x1b[0m" +
        line.slice(textEnd),
    ];
  }
}
