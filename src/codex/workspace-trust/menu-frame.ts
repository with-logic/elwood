/** Match a Codex trust layout to captured launch evidence at an exact native frame (C-ATTN-07). */
import { workspaceTrustMenuIdentity } from "../../core/dialogs/workspace-trust-request.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import { hasUnwrappedRowEndPadding } from "../../terminal/snapshot.ts";
import type { CodexLaunchTrustEvidence } from "./launch-evidence.ts";
import { createCodexWorkspaceTrustMatcher } from "./target.ts";

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
    const menu = match(frame, ({ rowIndex, rightInsetCols }) =>
      hasUnwrappedRowEndPadding(terminal.xterm, {
        viewportRow: rowIndex,
        rightInsetColumns: rightInsetCols,
        allowAsciiPadding: rightInsetCols > 0,
      }),
    );
    if (!menu) return undefined;
    const identity = workspaceTrustMenuIdentity(menu);
    return { frame, menu, identity, revalidateLaunchEvidence: evidence.isCurrent };
  };
}
