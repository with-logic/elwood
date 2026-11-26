/**
 * The startup welcome box Codex draws above a fresh composer (PRD §5.3/§5.4, C-API-31/C-TRUST-01).
 */

/** A contiguous startup welcome box and its native tip/warning rows. */
export function codexWelcomeBox(rows: readonly string[]): boolean {
  if (!/^╭─+╮$/.test(rows[0] ?? "")) return false;
  if (!/^│\s*>_ OpenAI Codex \(v[\d.]+\)\s*│$/.test(rows[1] ?? "")) return false;
  if (!/^│\s*│$/.test(rows[2] ?? "")) return false;
  if (!/^│ model:\s+\S.*\s+\/model to change\s*│$/.test(rows[3] ?? "")) return false;
  if (!/^│ directory:\s+\S.*│$/.test(rows[4] ?? "")) return false;
  if (!/^╰─+╯$/.test(rows[5] ?? "")) return false;
  let inTip = false;
  return rows.slice(6).every((row) => {
    if (row === "") return true;
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
