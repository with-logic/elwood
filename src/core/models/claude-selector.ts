/** Maps native Claude picker labels to CLI selectors without inventing custom IDs (PRD §5.3). */

const family = "(?:opus|sonnet|haiku|fable)";
const alias = new RegExp(`^(?:default|${family}(?:\\[1m\\])?)$`);
const versioned = new RegExp(`^${family} \\d+(?:\\.\\d+)?(?:\\[1m\\])?$`);
const fullSelector = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*(?:\[1m\])?$/;

export function claudeModelSelector(value: string): string | null {
  const lower = value
    .trim()
    .toLowerCase()
    .replace(/ \(1m context\)$/, "[1m]");
  if (alias.test(lower) || fullSelector.test(lower)) return lower;
  return versioned.test(lower) ? `claude-${lower.replace(/[ .]/g, "-")}` : null;
}
