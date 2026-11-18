/** Maps native Claude labels and legacy switch targets to selectors (PRD §5.3, C-API-24). */
import type { AgentModelOption } from "../../core/models/rows.ts";

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

export function claudeModelTarget(id: string): (option: AgentModelOption) => boolean {
  const label = id.toLowerCase();
  const wanted = claudeModelSelector(id) ?? label;
  return (option) =>
    option.id === wanted || (option.id === null && option.label.toLowerCase() === label);
}
