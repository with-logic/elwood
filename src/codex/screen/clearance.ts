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
  /^ {2}gpt-[\w.-]+ (?:minimal|low|medium|high|xhigh|default)(?: · (?:\/|[A-Z]:[\\/])[^\n]*)?$/;
const hintFooter = /^(?: {2})?\? for shortcuts$/;

/** A contiguous startup welcome box and its native tip/warning rows. */
function welcomeBox(rows: readonly string[]): boolean {
  if (!/^╭─+╮$/.test(rows[0] ?? "")) return false;
  if (!/^│\s*>_ OpenAI Codex \(v[\d.]+\)\s*│$/.test(rows[1] ?? "")) return false;
  const bottom = rows.findIndex((row) => /^╰─+╯$/.test(row));
  if (bottom < 2 || !rows.slice(1, bottom).every((row) => /^│.*│$/.test(row))) return false;
  let inTip = false;
  return rows.slice(bottom + 1).every((row) => {
    if (/^ {2}Tip: /.test(row)) {
      inTip = true;
      return true;
    }
    if (/^⚠ /.test(row)) {
      inTip = false;
      return true;
    }
    return inTip && /^ {2}\S/.test(row);
  });
}

/**
 * Only the last composer and the native rows below it can prove clearance. Earlier
 * numbered rows can be transcript content; an earlier footer cannot vouch for a
 * newly painted bare caret, which is also how a dialog's selected option starts.
 */
export function codexComposerClearance(frame: string): boolean {
  if (/esc to interrupt/i.test(frame)) return false;
  const rows = frame
    .split("\n")
    .map((row) => row.trimEnd())
    .filter((row) => row.trim().length > 0);
  const at = rows.findLastIndex((row) => caretRow.test(row));
  const composer = rows[at];
  // Native composer starts at column zero; transcript continuations are indented.
  if (composer === undefined || !/^›(?:\s|$)/.test(composer)) return false;
  if (!placeholders.has(composer.slice(1).trim())) return false;
  const below = rows.slice(at + 1);
  if (!below.every((row) => modelFooter.test(row) || hintFooter.test(row))) return false;
  if (below.some((row) => modelFooter.test(row))) return true;
  // A captured welcome box also anchors the known placeholder. A bare caret alone
  // remains ambiguous even when an old welcome box is still visible above it.
  return composer !== "›" && welcomeBox(rows.slice(0, at));
}
