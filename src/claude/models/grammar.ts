/** Claude's native model windows, disclosures, and effort controls (PRD §5.3, C-API-24/55). */
import { claudeModelFooter } from "../../core/models/hints.ts";
import { claudeModelPickerHeader } from "../../core/models/rows.ts";
import { viewportTail } from "../../core/models/viewport/syntax.ts";
import type { ViewportGrammar } from "../../core/models/viewport/types.ts";
import { type ClaudeReasoningEffort, claudeReasoningEfforts } from "../../core/reasoning-effort.ts";

import { claudeModelSelector } from "./selector.ts";

// The highlighted model owns this control; High's glyph is otherwise an agent-reply bullet.
// The exhaustive map and canonical tuple keep full rows and painting prefixes in sync.
const effortLabels = {
  low: "○ Low effort",
  medium: "◐ Medium effort",
  high: "● High effort",
  xhigh: "◉ xHigh effort",
  max: "◈ Max effort",
} as const satisfies Readonly<Record<ClaudeReasoningEffort, string>>;
const efforts = claudeReasoningEfforts.map((effort) => effortLabels[effort]);
const controlRow = new RegExp(
  `^\\s*(?:(?:${efforts.join("|")})(?: \\(default\\))?(?: ←/→ to adjust)?|○ Effort not supported for \\S.*)\\s*$`,
  "i",
);
const effortPrefixes = efforts.flatMap((effort) => [
  effort,
  `${effort} (default)`,
  `${effort} ←/→ to adjust`,
  `${effort} (default) ←/→ to adjust`,
]);
const hints = [
  "←/→ to adjust · s to use this session only · Enter to save · Esc to cancel",
  "Enter to set as default · s to use this session only · Esc to cancel",
  "Enter to expand · Esc to cancel",
  "Enter to collapse · Esc to cancel",
  "Esc to cancel",
];
const maxEffortWarning =
  "May use excessive tokens resulting in long response times or overthinking. Use sparingly for the hardest tasks.";
const hintPrefix = (line: string) =>
  hints.some((complete) => complete.toLowerCase().startsWith(line.toLowerCase()));

export const claudeViewportGrammar: ViewportGrammar = {
  agent: "claude",
  selector: claudeModelSelector,
  header: claudeModelPickerHeader,
  footer: claudeModelFooter,
  controlRow,
  // Older Claude attaches the arrows to numbered rows and counts hidden model rows below.
  scroll: { above: /^\s*↑/, below: /^\s*↓/, overflow: /^\s*…\s*\+(?<hidden>\d+) models?\s*$/ },
  marker: /^\s*([↑↓]) (\d+) more\s*$/,
  countedMarkers: true,
  partialMarker: /^\s*([↑↓])(?:\s+\d+(?:\s+(\S*))?)?\s*$/,
  markerSuffix: "more",
  disclosure: {
    row: /^\s*(❯|›)?\s*([▸▾])\s+More models\s*$/,
    partial: /^\s*(?:❯|›)?\s*[▸▾]\s*(.*)$/,
    label: "More models",
  },
  validTail: (lines, footer, selectedDisclosureExpanded) => {
    const tail = viewportTail(lines);
    if (selectedDisclosureExpanded !== undefined)
      return (
        tail.length === 0 &&
        new RegExp(`\\bEnter to ${selectedDisclosureExpanded ? "collapse" : "expand"}\\b`).test(
          footer,
        )
      );
    const first = tail[0];
    return (
      first !== undefined &&
      controlRow.test(first) &&
      (tail.length === 1 || tail.slice(1).join(" ") === maxEffortWarning)
    );
  },
  prefixTail: (lines) => {
    const tail = viewportTail(lines);
    const first = tail[0];
    if (first === undefined) return true;
    if (tail.length === 1 && hintPrefix(first)) return true;
    if (!(controlRow.test(first) || effortPrefixes.some((complete) => complete.startsWith(first))))
      return false;
    const rest = tail.slice(1);
    const last = rest.at(-1);
    if (last !== undefined && hintPrefix(last)) rest.pop();
    return maxEffortWarning.startsWith(rest.join(" "));
  },
};
