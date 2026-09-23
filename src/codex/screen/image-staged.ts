/** Codex image recovery requires a visible idle native composer (PRD §5.3, C-API-44). */
import { liveImageChipCount } from "../../core/images/live-chip.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { codexScreenFactTable } from "../screen-table.ts";
import { codexComposerRowsClearance } from "./clearance.ts";

export function codexImageStaged(terminal: ElwoodTerminal): boolean {
  return (
    liveImageChipCount(
      terminal,
      codexComposerRowsClearance,
      codexScreenFactTable,
      "› Ask Codex to do anything",
    ) > 0
  );
}
