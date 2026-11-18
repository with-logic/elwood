/** Validates native selectable positions against numbered model rows (PRD §5.3, C-API-24). */
import type { ElwoodAgentKind } from "../../activity/index.ts";
import type { ViewportItem } from "./types.ts";

/** Counted positions can differ from model numbers only by the one disclosure item. */
export function validPositions(
  items: readonly ViewportItem[],
  offset: number,
  agent: ElwoodAgentKind,
) {
  const disclosure = items.findIndex((item) => item.kind === "disclosure");
  return items.every((item, index) => {
    if (item.kind === "disclosure") return true;
    const actual = offset + index + 1 - item.row.absoluteRowNumber;
    if (agent === "codex") return actual === 0;
    if (disclosure >= 0) return actual === (index > disclosure ? 1 : 0);
    return actual === 0 || actual === 1;
  });
}
