/** Keep pasted data from becoming terminal control input (PRD §5.3, C-API-31). */

// C0 (\u0000-\u001f) and C1 (\u007f-\u009f) control chars EXCEPT tab,
// newline, and carriage return, which are legitimate multi-line whitespace.
// Stripping ESC (\u001b) alone already defuses the ESC[200~ / ESC[201~
// bracketed-paste sentinels, leaving only inert `[20x~` text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: neutralizing control input is the point.
const pasteUnsafe = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Neutralizes caller/model text before it is framed as a bracketed paste (§5.3).
 * Message text is data, so an embedded `ESC[201~` end sentinel (or a bare control
 * byte) MUST NOT terminate paste mode early and turn following bytes into live
 * keystrokes — e.g. an Enter that confirms a permission dialog. Tab, newline, and
 * carriage return survive as legitimate multi-line text; everything else is
 * stripped. `sendKeys` is the raw escape hatch and never goes through here.
 */
export function sanitizePasteText(text: string): string {
  return text.replace(pasteUnsafe, "");
}
