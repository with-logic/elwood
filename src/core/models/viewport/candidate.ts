/** Holds input on native model prefixes without making them navigable (PRD §5.3, C-API-24/55). */
import type { ElwoodAgentKind } from "../../activity/index.ts";
import { validPositions } from "./positions.ts";
import { readViewport } from "./read.ts";
import {
  effortRow,
  maxEffortWarning,
  unsupportedEffort,
  validViewportTail,
  viewportTail,
} from "./syntax.ts";

const claudeHint = "←/→ to adjust · s to use this session only · Enter to save · Esc to cancel";
const hints = {
  claude: [
    claudeHint,
    "Enter to set as default · s to use this session only · Esc to cancel",
    "Enter to expand · Esc to cancel",
    "Enter to collapse · Esc to cancel",
    "Esc to cancel",
  ],
  codex: ["enter select · esc back"],
};
const efforts = [
  "○ Low effort",
  "◐ Medium effort",
  "● High effort",
  "◉ xHigh effort",
  "◈ Max effort",
].flatMap((effort) => [
  effort,
  `${effort} (default)`,
  `${effort} ←/→ to adjust`,
  `${effort} (default) ←/→ to adjust`,
]);

export function isModelViewportCandidate(text: string, agent: ElwoodAgentKind): boolean {
  const read = readViewport(text, agent, true);
  if (read === undefined) return false;
  const { block, footer, modern, offset, selectedDisclosureExpanded } = read;
  if (!modern) return false;
  const { items, tail } = block;
  if (
    !(footer
      ? validViewportTail(tail, footer, agent, selectedDisclosureExpanded)
      : prefixTail(tail, agent))
  )
    return false;
  return validPositions(items, offset, agent);
}

function prefixTail(lines: readonly string[], agent: ElwoodAgentKind): boolean {
  const tail = viewportTail(lines);
  const first = tail[0];
  if (first === undefined) return true;
  const hint = (line: string) =>
    hints[agent].some((complete) => complete.toLowerCase().startsWith(line.toLowerCase()));
  if (tail.length === 1 && hint(first)) return true;
  if (agent === "codex") return false;
  const effort =
    effortRow.test(first) ||
    unsupportedEffort.test(first) ||
    efforts.some((complete) => complete.startsWith(first));
  if (!effort) return false;
  const rest = tail.slice(1);
  const last = rest.at(-1);
  if (last !== undefined && hint(last)) rest.pop();
  return maxEffortWarning.startsWith(rest.join(" "));
}
