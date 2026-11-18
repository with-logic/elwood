/** Shared complete/prefix reads of a native model block; prefixes carry no write authority (C-API-24/55). */
import type { ElwoodAgentKind } from "../../activity/index.ts";
import { claudeModelPickerHeader, codexModelPickerHeader } from "../rows.ts";
import { ViewportBlock } from "./block.ts";
import { effortRow, unsupportedEffort, viewportBody } from "./syntax.ts";

export function readViewport(text: string, agent: ElwoodAgentKind, prefix = false) {
  const header = agent === "claude" ? claudeModelPickerHeader : codexModelPickerHeader;
  const body = viewportBody(text, header, agent, prefix);
  if (body === undefined) return undefined;
  const block = new ViewportBlock(agent, prefix);
  if (!body.lines.every((line) => block.accept(line))) return undefined;
  const { rows, items, cursorOptionIndex, cursorItemIndex, above, below, tail } = block;
  const selected = items[cursorItemIndex];
  const selectedDisclosureExpanded =
    selected?.kind === "disclosure" ? selected.expanded : undefined;
  const modern =
    above ||
    below ||
    block.nativePartial ||
    items.some((item) => item.kind === "disclosure") ||
    tail.some((line) => effortRow.test(line.trim()) || unsupportedEffort.test(line.trim()));
  const first = rows[0];
  const offset =
    agent === "codex" && above && first !== undefined ? first.absoluteRowNumber - 1 : block.offset;
  const parsed = {
    rows,
    options: rows.map((row) => row.option),
    cursorOptionIndex,
    hiddenRowCountBelow: 0,
  };
  return { parsed, block, footer: body.footer, modern, offset, selectedDisclosureExpanded };
}
