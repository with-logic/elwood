/**
 * Claude's native composer footer: the row directly beneath the composer's bottom rule
 * (PRD §5.3, §5.4; C-TRUST-01, C-API-55, C-API-56, C-ATTN-10).
 *
 * Captured on Claude Code 2.1.310 for every `--permission-mode` (see
 * `tests/fixtures/claude-2.1.310/mode-footers/`), on top of the 2.1.278 to 2.1.305 rows:
 *
 *   -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents      0 tokens
 *   ⏸ manual mode on · ? for shortcuts · ← for agents                       ● high · /effort
 *
 * Vim's `-- INSERT --` shows only in vim insert mode. Manual mode has no cycle hint.
 * Claude hides `← for agents` after the session has been open a while (it was gone 27 s
 * after launch in the captures). The right edge holds the token count when `verbose` is on,
 * otherwise the effort level, and can be empty. The version banner scrolls away in a long
 * session, so this row is what proves an idle composer.
 */

const mode =
  "(?:⏸ (?:manual|plan) mode|⏵⏵ (?:accept edits|auto mode|don['’]t ask|bypass permissions)) on";
const hints = String.raw`(?: \(shift\+tab to cycle\))?(?: · \? for shortcuts)?(?: · ← for agents)?`;
/**
 * A token count as Claude prints it: 2.1.310 formats with compact notation, lowercased
 * (`0`, `999`, `1.0k`, `12.3k`, `2.1m`); the grouped and uppercase forms stay accepted.
 */
export const claudeTokenCount = String.raw`[\d,.]+[kKmM]? tokens`;
const effortLevel = String.raw`[○◐●◉◈] (?:low|medium|high|xhigh|max) · \/effort`;

/** One footer row, as a single-line fragment with no anchors. */
export const claudeComposerFooterRow = String.raw`[ \t]*(?:-- INSERT -- )?${mode}${hints}(?: +(?:${claudeTokenCount}|${effortLevel}))?[ \t]*`;
export const claudeComposerFooter = new RegExp(`^${claudeComposerFooterRow}$`);

/** A footer item on its own row: effort below a token count, or the count when narrow. */
export const claudeFooterOverflow = new RegExp(
  String.raw`^\s*(?:${claudeTokenCount}|${effortLevel})\s*$`,
);

/** The mode item that opens a footer row, idle or working (`· esc to interrupt` follows). */
const footerMode = new RegExp(String.raw`^[ \t]*(?:-- INSERT -- )?(${mode})(?=\s|$)`);
/** A rule with no label: the composer's bottom rule, the last one on screen. */
const plainRule = /^[─━]{3,}\s*$/;

/**
 * The permission mode that Claude's footer shows, as in `⏵⏵ auto mode on`. It is read from
 * the row under the screen's last plain rule, so transcript text that quotes a mode is never
 * taken for it (C-ATTN-10).
 */
export function claudeFooterMode(text: string): string | undefined {
  const rows = text.split("\n");
  const bottomRule = rows.findLastIndex((row) => plainRule.test(row));
  return bottomRule < 0 ? undefined : footerMode.exec(rows[bottomRule + 1] ?? "")?.[1];
}
