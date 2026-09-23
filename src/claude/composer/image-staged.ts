/** Claude image recovery requires a visible idle native composer (PRD §5.3, C-API-44). */
import { liveImageChipCount } from "../../core/images/live-chip.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { claudeScreenFactTable } from "../screen-table.ts";
import { claudeEmptyInputRows } from "./empty-input.ts";

export function claudeImageStaged(terminal: ElwoodTerminal): boolean {
  return liveImageChipCount(terminal, claudeEmptyInputRows, claudeScreenFactTable, "❯ ") > 0;
}
