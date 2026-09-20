/** The last native Claude composer proves post-picker clearance (C-API-55). */
import { claudeTrustClearance } from "./screen-table.ts";

export function claudeModelComposerClearance(frame: string): boolean {
  if (/esc to interrupt/i.test(frame)) return false;
  const rows = frame.split("\n");
  const composer = rows.findLastIndex((row) => /^\s*❯/.test(row));
  // /model is retained as an earlier transcript caret after Escape. Only the last
  // composer, its enclosing rules, and its own native footer establish clearance.
  return composer > 0 && claudeTrustClearance(rows.slice(composer - 1).join("\n"));
}
