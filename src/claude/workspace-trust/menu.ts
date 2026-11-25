/** Match Claude's native workspace trust disclosure to a checked launch (C-ATTN-07). */
import type { IBufferCell } from "@xterm/headless";
import { workspaceTrustMenuIdentity } from "../../core/dialogs/workspace-trust-request.ts";
import type { SelectableOption } from "../../core/terminal-options.ts";
import { type TrustCandidate, trustView } from "../../core/trust/view.ts";
import type { ElwoodTerminal, TerminalSnapshot, XtermTerminal } from "../../terminal/headless.ts";
import { hasUnwrappedRowEndPadding } from "../../terminal/snapshot.ts";
import type { ClaudeLaunchTrustEvidence } from "./target.ts";

// The captured prelude starts four rows above the question. Keep a nearby window
// for layout spacing without accepting a detached disclosure elsewhere on screen.
const workspacePreludeRows = 8;

type MatchedWorkspaceTrustMenu = {
  readonly target: Pick<ClaudeLaunchTrustEvidence["scope"], "targetPath" | "targetScope">;
  readonly dialog: TrustCandidate["dialog"];
};

export type WorkspaceTrustFrame = {
  readonly frame: TerminalSnapshot;
  readonly menu: MatchedWorkspaceTrustMenu;
  readonly identity: string;
  readonly revalidateLaunchEvidence: ClaudeLaunchTrustEvidence["isCurrent"];
};

export function createClaudeWorkspaceTrustFrameMatcher(evidence: ClaudeLaunchTrustEvidence) {
  const match = createClaudeWorkspaceTrustMenuMatcher(evidence.scope);
  return (terminal: ElwoodTerminal, frame: TerminalSnapshot): WorkspaceTrustFrame | undefined => {
    const menu = match(terminal, frame);
    if (!menu) return undefined;
    const identity = workspaceTrustMenuIdentity(menu);
    return { frame, menu, identity, revalidateLaunchEvidence: evidence.isCurrent };
  };
}

export function createClaudeWorkspaceTrustMenuMatcher(scope: ClaudeLaunchTrustEvidence["scope"]) {
  return (
    terminal: ElwoodTerminal,
    frame: TerminalSnapshot,
  ): MatchedWorkspaceTrustMenu | undefined => {
    const candidate = trustView(frame.text, "claude", () => false);
    if (
      candidate.kind !== "candidate" ||
      candidate.spec.id !== "workspace_trust" ||
      !candidate.valid ||
      !hasWorkspaceMenu(frame, candidate)
    )
      return undefined;

    const firstRow = Math.max(0, candidate.headerRow - workspacePreludeRows);
    const prelude = frame.lines.slice(firstRow, candidate.headerRow);
    const heading = prelude.findIndex((row) => row.trim() === "Accessing workspace:");
    if (heading < 0) return undefined;
    const details = prelude.slice(heading + 1);
    const firstPathRow = details.findIndex((row) => row.trim().length > 0);
    if (firstPathRow < 0) return undefined;
    const lastPathRow = details.findLastIndex((row) => row.trim().length > 0);
    const pathRows = details.slice(firstPathRow, lastPathRow + 1);
    const viewportRow = firstRow + heading + 1 + firstPathRow;
    if (!matchesWorkspacePath(terminal.xterm, viewportRow, pathRows, scope.physicalLaunchPath))
      return undefined;
    const { targetPath, targetScope } = scope;
    return { target: { targetPath, targetScope }, dialog: candidate.dialog };
  };
}

function matchesWorkspacePath(
  xterm: XtermTerminal,
  firstRow: number,
  rows: readonly string[],
  expectedPath: string,
): boolean {
  const lastRow = firstRow + rows.length - 1;
  if (!hasUnwrappedRowEndPadding(xterm, { viewportRow: lastRow, rightInsetColumns: 0 }))
    return false;
  if (rows.length === 1) return rows[0]?.trimStart() === expectedPath;

  // Claude's renderer wraps at the two margins, rather than using xterm's
  // soft wrap. Each nonfinal row must fill the whole payload width.
  const buffer = xterm.buffer.active;
  const rightMargin = xterm.cols - 1;
  const exactMargins = rows.every((_, offset) => {
    const line = buffer.getLine(buffer.baseY + firstRow + offset);
    if (line?.isWrapped !== false || !isUnusedCell(line.getCell(0))) return false;
    if (offset === rows.length - 1) return true;
    // A width-zero cell is the trailing column of an occupied wide glyph.
    const payloadEnd = line.getCell(rightMargin - 1);
    return (
      isUnusedCell(line.getCell(rightMargin)) &&
      (payloadEnd?.getWidth() === 0 || Boolean(payloadEnd?.getChars()))
    );
  });
  return exactMargins && rows.map((row) => row.slice(1)).join("") === expectedPath;
}

function isUnusedCell(cell: IBufferCell | undefined): boolean {
  return cell?.getChars() === "" && cell.getWidth() === 1;
}

function hasWorkspaceMenu(frame: TerminalSnapshot, candidate: TrustCandidate): boolean {
  const choices = candidate.dialog.options;
  if (choices.length !== 2) return false;
  const [first, second] = [choices[0]!, choices[1]!];
  const labels = [first.label, second.label];
  return (
    labels.includes("No, exit") &&
    labels.includes("Yes, I trust this folder") &&
    hasWorkspaceOptionLayout(first, second) &&
    frame.lines.findLast((line) => line.trim().length > 0)?.trim() ===
      "Enter to confirm · Esc to cancel"
  );
}

function hasWorkspaceOptionLayout(first: SelectableOption, second: SelectableOption): boolean {
  if (first.style === "cursor") return second.style === "cursor";
  return (
    second.style === "numbered" &&
    first.number === "1" &&
    second.number === "2" &&
    first.selected !== second.selected
  );
}
