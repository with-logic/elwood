/** Measure Codex screen text in terminal columns, as Codex lays rows out (PRD §5.3, §5.10). */

// Code points a terminal draws two columns wide: East Asian wide and fullwidth forms, emoji.
// The ranges approximate the East Asian Width table; a missed range counts one column short.
const wideCodePoint =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/gu;

/** The columns `text` takes: doubling each wide code point makes the counts equal. */
export function displayColumns(text: string): number {
  return [...text.replace(wideCodePoint, "$&$&")].length;
}
