/** Native model-window boundaries and control rows (PRD §5.3, C-API-24). */
import type { ElwoodAgentKind } from "../../activity/index.ts";
import { positiveCount } from "../counts.ts";
import { claudeModelFooter, codexModelFooter, isModelFooter } from "../hints.ts";
export const blankOrRule = /^\s*(?:[─━▔]{3,})?\s*$/;
export const disclosureRow = /^\s*(❯|›)?\s*([▸▾])\s+More models\s*$/;
export const effortRow =
  /^[○◐●◉◈] (?:Low|Medium|High|xHigh|Max) effort(?: \(default\))?(?: ←\/→ to adjust)?$/i;
export const unsupportedEffort = /^○ Effort not supported for \S.*$/;
export const maxEffortWarning =
  "May use excessive tokens resulting in long response times or overthinking. Use sparingly for the hardest tasks.";
const foreignRow = /^\s*(?:[❯›»●•⏺↑↓]|\d+[.)]\s)/;

/** Only a closing hint row, followed by blank/rule rows, completes the region. */
export function viewportBody(
  text: string,
  header: RegExp,
  agent: ElwoodAgentKind,
  prefix: boolean,
) {
  if (!header.test(text)) return undefined;
  const lines = text.split("\n");
  const start = lines.findLastIndex((line) => header.test(line));
  if (start < 0 || foreignRow.test(lines[start] as string)) return undefined;
  const body = lines.slice(start + 1);
  const footerPattern = agent === "claude" ? claudeModelFooter : codexModelFooter;
  const footerIndex = body.findIndex((line) => footerPattern.test(line));
  const footer = body[footerIndex];
  if (footer === undefined && prefix) return { lines: body, footer: "" };
  if (
    footer === undefined ||
    !isModelFooter(footer, footerPattern) ||
    body.slice(footerIndex + 1).some((line) => !blankOrRule.test(line))
  )
    return undefined;
  return { lines: body.slice(0, footerIndex), footer };
}

/** A malformed or misplaced marker is never treated as ordinary dialog prose. */
export function viewportMarker(line: string, agent: ElwoodAgentKind) {
  const pattern = agent === "claude" ? /^\s*([↑↓]) (\d+) more\s*$/ : /^\s*([↑↓])\s*$/;
  const match = pattern.exec(line);
  if (match === null) return undefined;
  const count = agent === "claude" ? positiveCount(match[2]) : undefined;
  if (agent === "claude" && count === undefined) return undefined;
  return { direction: match[1] as "↑" | "↓", count };
}

export function validViewportTail(
  lines: readonly string[],
  footer: string,
  agent: ElwoodAgentKind,
  selectedDisclosureExpanded: boolean | undefined,
): boolean {
  const tail = viewportTail(lines);
  if (agent === "codex") return tail.length === 0;
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
    (effortRow.test(first) || unsupportedEffort.test(first)) &&
    (tail.length === 1 || tail.slice(1).join(" ") === maxEffortWarning)
  );
}

export function foreignViewportRow(line: string): boolean {
  return foreignRow.test(line);
}

export function viewportTail(lines: readonly string[]): string[] {
  return lines.filter((line) => !blankOrRule.test(line)).map((line) => line.trim());
}
