/** Match Codex's native folder-access disclosure to a checked launch target (PRD §5.5). */
import { isGenericTrustDialogFooter, type TrustDialog } from "../../core/trust/dialog.ts";
import { codexFolderAccessFooter, codexFolderAccessLabels } from "../../core/trust/options.ts";
import { trustView } from "../../core/trust/view.ts";
import type { TerminalSnapshot } from "../../terminal/headless.ts";
import { folderAccessPrelude, legacyLocationPrelude } from "../screen/workspace-trust-copy.ts";
import type { WorkspaceTrustTarget } from "./types.ts";

const repositoryNote =
  "Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:";
const folderAccess = {
  acceptLabel: codexFolderAccessLabels.accept,
  isPrelude: (text: string) => text.trimEnd() === folderAccessPrelude,
  matches: modernMatches,
} as const;
const codexWorkspaceLayouts = [
  {
    acceptLabel: "Yes, continue",
    declineLabel: "No, quit",
    footer: "Press enter to continue",
    isPrelude: (text: string) => text.startsWith(legacyLocationPrelude),
    matches: legacyMatches,
  },
  {
    ...folderAccess,
    declineLabel: codexFolderAccessLabels.quit,
    footer: "enter continue · esc quit",
  },
  {
    ...folderAccess,
    declineLabel: codexFolderAccessLabels.back,
    footer: codexFolderAccessFooter,
  },
] as const;

type CheckedTrustTarget = {
  readonly target: WorkspaceTrustTarget;
  readonly requiresRepositoryNote: boolean;
};
type LaunchEvidence = {
  readonly launchDirectoryPaths: readonly string[];
  readonly targets: readonly CheckedTrustTarget[];
};

type Row = { readonly index: number; readonly text: string };
/** Certifies that the path at a zero-based snapshot row fits before the right inset without clipping or wrapping. */
type RowFits = (position: {
  readonly rowIndex: number;
  readonly rightInsetCols: number;
}) => boolean;
type Layout = (typeof codexWorkspaceLayouts)[number];

export type CodexWorkspaceTrustMatcher = (
  frame: Pick<TerminalSnapshot, "lines">,
  rowFits: RowFits,
) => { readonly target: WorkspaceTrustTarget; readonly dialog: TrustDialog } | undefined;

/** Match a native frame against independent captured launch evidence. */
export function createCodexWorkspaceTrustMatcher({
  launchDirectoryPaths,
  targets,
}: LaunchEvidence): CodexWorkspaceTrustMatcher {
  return ({ lines }, rowFits) => {
    const menu = matchWorkspaceMenu(lines);
    if (!menu) return undefined;
    const { headerRow, layout } = menu;
    const prefix = disclosureRows(lines, headerRow, layout);
    if (!prefix) return undefined;

    let result: WorkspaceTrustTarget | undefined;
    for (const checked of targets) {
      if (!layout.matches(prefix, checked, launchDirectoryPaths, rowFits)) continue;
      if (
        result &&
        (result.targetPath !== checked.target.targetPath ||
          result.targetScope !== checked.target.targetScope)
      )
        return undefined;
      result = checked.target;
    }
    return result && { target: result, dialog: menu.dialog };
  };
}

function matchWorkspaceMenu(lines: readonly string[]) {
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
  if (!expectedChoicePair) return undefined;
  const exactlyOneSelected = accept.selected !== decline.selected;
  if (!exactlyOneSelected) return undefined;
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
  return { headerRow: candidate.headerRow, layout, dialog: candidate.dialog };
}

function disclosureRows(lines: readonly string[], end: number, layout: Layout): Row[] | undefined {
  const start = lines.slice(0, end).findLastIndex((line) => layout.isPrelude(line.trimStart()));
  if (start < 0) return undefined;

  return lines.slice(start, end).flatMap((line, offset) => {
    const text = stripRowPadding(line);
    return text.length === 0 ? [] : [{ index: start + offset, text }];
  });
}

function modernMatches(
  rows: readonly Row[],
  { target: { targetPath, targetScope }, requiresRepositoryNote }: CheckedTrustTarget,
  launchDirectoryPaths: readonly string[],
  fits: RowFits,
): boolean {
  const targetRow = rows.at(-1);
  const targetRowFits = targetRow && fits({ rowIndex: targetRow.index, rightInsetCols: 2 });
  if (!targetRowFits || targetRow.text !== stripRowPadding(targetPath)) return false;
  const details = rows.slice(1, -1);
  const [cwd] = details;
  if (!cwd) return !requiresRepositoryNote && launchDirectoryPaths.includes(targetPath);
  if (targetScope !== "repository") return false;
  if (cwd.text.startsWith("/")) {
    const matchesAlias = launchDirectoryPaths.some(
      (alias) => alias !== targetPath && cwd.text === stripRowPadding(alias),
    );
    const cwdRowFits = fits({ rowIndex: cwd.index, rightInsetCols: 2 });
    const repositoryDisclosed = noteText(details.slice(1)) === repositoryNote;
    return cwdRowFits && matchesAlias && repositoryDisclosed;
  }
  return (
    launchDirectoryPaths.some((alias) => alias !== targetPath) &&
    noteText(details) === repositoryNote
  );
}

function legacyMatches(
  rows: readonly Row[],
  { target: { targetPath, targetScope }, requiresRepositoryNote }: CheckedTrustTarget,
  launchDirectoryPaths: readonly string[],
  fits: RowFits,
): boolean {
  const [cwd, ...note] = rows;
  const cwdRowFits = cwd && fits({ rowIndex: cwd.index, rightInsetCols: 0 });
  if (!cwdRowFits) return false;
  const matchingAliases = launchDirectoryPaths.filter(
    (alias) => cwd.text === legacyLocationPrelude + stripRowPadding(alias),
  );
  if (note.length === 0) return !requiresRepositoryNote && matchingAliases.includes(targetPath);
  const repositoryDisclosed =
    targetScope === "repository" &&
    matchingAliases.some((alias) => alias !== targetPath) &&
    noteText(note) === `${repositoryNote} ${stripRowPadding(targetPath)}`;
  return repositoryDisclosed && legacyPathRowsFit(note, fits);
}

/** The legacy disclosure joins the note and the path, so a row may contain both. */
function legacyPathRowsFit(note: readonly Row[], fits: RowFits): boolean {
  let pathOffset = repositoryNote.length + 1;
  for (const { index, text } of note) {
    if (text.length > pathOffset && !fits({ rowIndex: index, rightInsetCols: 0 })) return false;
    pathOffset -= text.length + 1;
  }
  return true;
}

function noteText(rows: readonly Row[]): string {
  return rows.map(({ text }) => text).join(" ");
}

/** Ratatui can pad with ASCII spaces. Only independently verified paths supply exact bytes. */
function stripRowPadding(text: string): string {
  return text.replace(/^ +| +$/g, "");
}
