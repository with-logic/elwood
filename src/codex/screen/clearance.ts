/** Positive native Codex composer evidence for dialog clearance (PRD §5.4, C-TRUST-01). */

const caretRow = /^\s*›/;
/** Codex 0.142.5's PLACEHOLDERS plus the captured 0.154.0 default. */
const placeholders = new Set([
  "",
  "Ask Codex to do anything",
  "Explain this codebase",
  "Summarize recent commits",
  "Implement {feature}",
  "Find and fix a bug in @filename",
  "Write tests for @filename",
  "Improve documentation in @filename",
  "Run /review on my current changes",
  "Use /skills to list available skills",
]);
const modelFooter =
  /^gpt-[\w.-]+ (?:minimal|low|medium|high|xhigh|default)(?: · (?:\/|[A-Z]:[\\/])[^\n]*)?$/;
const hintFooter = /^\? for shortcuts$/;

/**
 * Only the last composer and the native rows below it can prove clearance. Earlier
 * numbered rows can be transcript content; an earlier footer cannot vouch for a
 * newly painted bare caret, which is also how a dialog's selected option starts.
 */
export function codexComposerClearance(frame: string): boolean {
  const rows = frame
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean);
  const at = rows.findLastIndex((row) => caretRow.test(row));
  const composer = rows[at];
  if (composer === undefined || !placeholders.has(composer.slice(1).trim())) return false;
  const below = rows.slice(at + 1);
  if (!below.every((row) => modelFooter.test(row) || hintFooter.test(row))) return false;
  if (below.some((row) => modelFooter.test(row))) return true;
  // A captured welcome box also anchors the known placeholder. A bare caret alone
  // remains ambiguous even when an old welcome box is still visible above it.
  const above = rows.slice(0, at).join("\n");
  return (
    composer !== "›" && /^│\s*>_ OpenAI Codex \(v[\d.]+\)/m.test(above) && /^╰─+╯$/m.test(above)
  );
}
