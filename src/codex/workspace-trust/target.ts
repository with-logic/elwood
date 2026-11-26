/** Match Codex's native folder-access disclosure to a checked launch target (PRD §5.5). */
import { isGenericTrustDialogFooter } from "../../core/trust/dialog.ts";
import { codexFolderAccessFooter, codexFolderAccessLabels } from "../../core/trust/options.ts";
import { trustView } from "../../core/trust/view.ts";
import type { TerminalSnapshot } from "../../terminal/headless.ts";
import {
  type LaunchEvidence,
  matchesLaunchDisclosure,
  parseWorkspaceDisclosure,
  type RowFits,
} from "./disclosure.ts";
import type { WorkspaceTrustTarget } from "./types.ts";

const folderAccess = {
  acceptLabel: codexFolderAccessLabels.accept,
  preludeLayout: "folder access",
} as const;
const codexWorkspaceLayouts = [
  {
    acceptLabel: "Yes, continue",
    declineLabel: "No, quit",
    declineOutcome: "exit",
    footer: "Press enter to continue",
    preludeLayout: "legacy",
  },
  {
    ...folderAccess,
    declineLabel: codexFolderAccessLabels.quit,
    declineOutcome: "exit",
    footer: "enter continue · esc quit",
  },
  {
    ...folderAccess,
    declineLabel: codexFolderAccessLabels.back,
    declineOutcome: "back",
    footer: codexFolderAccessFooter,
  },
] as const;
export type CodexWorkspaceTrustMatcher = ReturnType<typeof createCodexWorkspaceTrustMatcher>;

/** Match a native frame against independent captured launch evidence. */
export function createCodexWorkspaceTrustMatcher({
  launchDirectoryPaths,
  targets,
}: LaunchEvidence) {
  return ({ lines }: Pick<TerminalSnapshot, "lines">, rowFits: RowFits) => {
    const menu = matchWorkspaceMenu(lines);
    if (!menu) return undefined;
    const { headerRow, layout } = menu;
    const disclosure = parseWorkspaceDisclosure(lines, headerRow, layout.preludeLayout, rowFits);
    if (!disclosure) return undefined;
    let result: WorkspaceTrustTarget | undefined;
    for (const checked of targets) {
      if (!matchesLaunchDisclosure(disclosure, checked, launchDirectoryPaths)) continue;
      if (
        result &&
        (result.targetPath !== checked.target.targetPath ||
          result.targetScope !== checked.target.targetScope)
      )
        return undefined;
      result = checked.target;
    }
    return (
      result &&
      ({
        target: result,
        // Codex's prompt states no per-folder facts beyond its target (§5.13).
        facts: {},
        dialog: menu.dialog,
        declineOutcome: layout.declineOutcome,
      } as const)
    );
  };
}

export function matchWorkspaceMenu(lines: readonly string[]) {
  const candidate = trustView(lines.join("\n"), "codex", () => false);
  if (candidate.kind !== "candidate" || !candidate.valid || candidate.spec.id !== "workspace_trust")
    return undefined;
  const [accept, decline, extra] = candidate.dialog.options;
  const expectedChoicePair =
    !extra &&
    accept?.style === "numbered" &&
    decline?.style === "numbered" &&
    accept.number === "1" &&
    decline.number === "2";
  if (!expectedChoicePair || accept.selected === decline.selected) return undefined;
  const footer = lines.findLast((line) => line.trim() !== "")?.trim();
  const layout = codexWorkspaceLayouts.find(
    (layout) =>
      layout.acceptLabel === accept.label &&
      layout.declineLabel === decline.label &&
      layout.footer === footer,
  );
  if (
    !layout ||
    lines.some(
      (line, row) =>
        row > candidate.headerRow && line.trim() !== footer && isGenericTrustDialogFooter(line),
    )
  )
    return undefined;
  return {
    headerRow: candidate.headerRow,
    layout,
    dialog: { ...candidate.dialog, options: [accept, decline] as const },
  };
}
