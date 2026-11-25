/** Match a Codex trust layout to captured launch evidence at an exact native frame (C-ATTN-07). */
import { workspaceTrustMenuIdentity } from "../../core/dialogs/workspace-trust-request.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import { hasUnwrappedRowEndPadding } from "../../terminal/snapshot.ts";
import { hasCompleteWorkspaceDisclosure, type RowFits } from "./disclosure.ts";
import type { CodexLaunchTrustEvidence } from "./launch-evidence.ts";
import { createCodexWorkspaceTrustMatcher, matchWorkspaceMenu } from "./target.ts";

type MatchedWorkspaceTrustMenu = NonNullable<
  ReturnType<ReturnType<typeof createCodexWorkspaceTrustMatcher>>
>;

export type WorkspaceTrustFrame = {
  readonly frame: TerminalSnapshot;
  readonly menu: MatchedWorkspaceTrustMenu;
  readonly identity: string;
  readonly revalidateLaunchEvidence: CodexLaunchTrustEvidence["isCurrent"];
};

export function createTrustFrameMatcher(evidence: CodexLaunchTrustEvidence) {
  const match = createCodexWorkspaceTrustMatcher({
    launchDirectoryPaths: evidence.aliases,
    targets: evidence.targets,
  });
  return (terminal: ElwoodTerminal, frame: TerminalSnapshot): WorkspaceTrustFrame | undefined => {
    const menu = match(frame, disclosureRowFits(terminal));
    if (!menu) return undefined;
    const identity = workspaceTrustMenuIdentity(menu);
    return { frame, menu, identity, revalidateLaunchEvidence: evidence.isCurrent };
  };
}

/** Check whether this native frame can veto a pending answer without a matching launch scope. */
export function hasCompleteWorkspaceTrustDisclosure(
  terminal: ElwoodTerminal,
  frame: TerminalSnapshot,
): boolean {
  const menu = matchWorkspaceMenu(frame.lines);
  return (
    menu !== undefined &&
    hasCompleteWorkspaceDisclosure(
      frame.lines,
      menu.headerRow,
      menu.layout.preludeLayout,
      disclosureRowFits(terminal),
    )
  );
}

function disclosureRowFits(terminal: ElwoodTerminal): RowFits {
  return ({ rowIndex, rightInsetCols }) =>
    hasUnwrappedRowEndPadding(terminal.xterm, {
      viewportRow: rowIndex,
      rightInsetColumns: rightInsetCols,
      allowAsciiPadding: rightInsetCols > 0,
    });
}
