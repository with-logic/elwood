/**
 * Claude's last composer as proof of an idle screen (PRD §5.3, §5.4; C-API-55, C-ATTN-02).
 * Earlier carets stay in Claude's transcript: each submitted prompt is echoed as
 * `❯ <prompt>`, and `/model` stays as `❯ /model` after the picker closes. Only the last
 * composer, its enclosing rules, and its own native footer establish clearance.
 */
import { claudeTrustClearance } from "../screen-table.ts";

export function claudeLastComposerClearance(frame: string): boolean {
  if (/esc to interrupt/i.test(frame)) return false;
  const rows = frame.split("\n");
  const composer = rows.findLastIndex((row) => /^\s*❯/.test(row));
  return composer > 0 && claudeTrustClearance(rows.slice(composer - 1).join("\n"));
}
