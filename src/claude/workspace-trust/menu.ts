/** Match Claude's native workspace trust disclosure to a checked launch (C-ATTN-07). */
import type { TrustPromptIdFor } from "../../core/trust/prompts.ts";
import { type TrustCandidate, trustView } from "../../core/trust/view.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
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
  readonly verifyTarget: ClaudeLaunchTrustEvidence["isCurrent"];
};

export function matchClaudeWorkspaceTrustFrame(
  evidence: ClaudeLaunchTrustEvidence,
  humanOwnedPrompt: () => TrustPromptIdFor<"claude"> | undefined,
) {
  const match = matchClaudeWorkspaceTrustMenu(evidence.scope);
  return (terminal: ElwoodTerminal, frame: TerminalSnapshot): WorkspaceTrustFrame | undefined => {
    if (humanOwnedPrompt() !== "workspace_trust") return undefined;
    const menu = match(terminal, frame);
    if (!menu) return undefined;
    const { target, dialog } = menu;
    const identity = JSON.stringify([
      target.targetPath,
      target.targetScope,
      dialog.header,
      dialog.options.map(({ label }) => label),
    ]);
    return { frame, menu, identity, verifyTarget: evidence.isCurrent };
  };
}

export function matchClaudeWorkspaceTrustMenu(scope: ClaudeLaunchTrustEvidence["scope"]) {
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

    // The parser and xterm use live-viewport rows. Retain the prelude's start
    // to verify cells on the same row as the full displayed path.
    const firstRow = Math.max(0, candidate.headerRow - workspacePreludeRows);
    const prelude = frame.lines.slice(firstRow, candidate.headerRow);
    const heading = prelude.findIndex((row) => row.trim() === "Accessing workspace:");
    if (heading < 0) return undefined;
    const details = prelude.slice(heading + 1);
    const pathRow = details.findIndex((row) => row.trim().length > 0);
    if (
      pathRow < 0 ||
      details[pathRow]!.trimStart() !== scope.physicalLaunchPath ||
      details.slice(pathRow + 1).some((row) => row.trim().length > 0)
    )
      return undefined;
    const viewportRow = firstRow + heading + 1 + pathRow;
    if (!hasUnwrappedRowEndPadding(terminal.xterm, { viewportRow, rightInsetColumns: 0 }))
      return undefined;
    const { targetPath, targetScope } = scope;
    return { target: { targetPath, targetScope }, dialog: candidate.dialog };
  };
}

function hasWorkspaceMenu(frame: TerminalSnapshot, candidate: TrustCandidate): boolean {
  const choices = candidate.dialog.options.map((option) => option.label);
  return (
    choices.length === 2 &&
    choices.includes("No, exit") &&
    choices.includes("Yes, I trust this folder") &&
    frame.lines.findLast((line) => line.trim().length > 0)?.trim() ===
      "Enter to confirm · Esc to cancel"
  );
}
