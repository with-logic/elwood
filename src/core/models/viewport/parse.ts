/** Parses counted Claude windows and uncounted Codex windows (PRD §5.3, C-API-23/24). */
import type { ElwoodAgentKind } from "../../activity/index.ts";
import type { ParsedModelPicker } from "../rows.ts";
import { validPositions } from "./positions.ts";
import { readViewport } from "./read.ts";
import { validViewportTail } from "./syntax.ts";

/** Undefined leaves older layouts to the existing attached-marker grammar. */
export function parseModelViewport(
  text: string,
  agent: ElwoodAgentKind,
): ParsedModelPicker | undefined {
  const read = readViewport(text, agent);
  if (read === undefined) return undefined;
  const { parsed, block, footer, modern, offset, selectedDisclosureExpanded } = read;
  const { items, tail, above, remainingBelow, cursorItemIndex } = block;
  if (parsed.rows.length < 2 || !validViewportTail(tail, footer, agent, selectedDisclosureExpanded))
    return undefined;
  if (!modern) return undefined;
  if (
    (above && offset < 1) ||
    !Number.isSafeInteger(offset + items.length + (remainingBelow ?? 0)) ||
    !validPositions(items, offset, agent)
  )
    return undefined;
  return { ...parsed, viewport: { items, offset, remainingBelow, cursorItemIndex } };
}
