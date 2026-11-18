/** Codex's uncounted native model windows and closing hints (PRD §5.7, C-API-24/55). */
import { codexModelFooter } from "../../core/models/hints.ts";
import { codexModelPickerHeader } from "../../core/models/rows.ts";
import { viewportTail } from "../../core/models/viewport/syntax.ts";
import type { ViewportGrammar } from "../../core/models/viewport/types.ts";

export const codexViewportGrammar: ViewportGrammar = {
  agent: "codex",
  header: codexModelPickerHeader,
  footer: codexModelFooter,
  marker: /^\s*([↑↓])\s*$/,
  countedMarkers: false,
  partialMarker: /^\s*([↑↓])(?:\s+\d+(?:\s+(\S*))?)?\s*$/,
  markerSuffix: "more",
  validTail: (lines) => viewportTail(lines).length === 0,
  prefixTail: (lines) => {
    const tail = viewportTail(lines);
    const first = tail[0];
    return (
      first === undefined ||
      (tail.length === 1 && "enter select · esc back".startsWith(first.toLowerCase()))
    );
  },
};
