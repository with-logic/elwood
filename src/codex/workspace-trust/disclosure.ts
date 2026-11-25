/** Parse native Codex workspace disclosures and verify their path rows (PRD §5.5). */
import {
  isFolderAccessPrelude,
  legacyLocationPreludePrefix,
} from "../screen/workspace-trust-copy.ts";
import type { WorkspaceTrustTarget } from "./types.ts";

const repositoryNote =
  "Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:";

type CheckedTrustTarget = {
  readonly target: WorkspaceTrustTarget;
  readonly requiresRepositoryNote: boolean;
};
export type LaunchEvidence = {
  readonly launchDirectoryPaths: readonly string[];
  readonly targets: readonly CheckedTrustTarget[];
};

type Row = { readonly index: number; readonly text: string };
/** Certifies that the path at a zero-based snapshot row fits before the right inset without clipping or wrapping. */
export type RowFits = (position: {
  readonly rowIndex: number;
  readonly rightInsetCols: number;
}) => boolean;

export type WorkspacePrelude =
  | { readonly layout: "folder access" }
  | { readonly layout: "legacy"; readonly location: string };

/** Parse the leading native disclosure row without claiming it names a verified path. */
export function readWorkspacePrelude(line: string): WorkspacePrelude | undefined {
  if (isFolderAccessPrelude(line)) return { layout: "folder access" };
  const text = line.trimStart();
  if (text.startsWith(legacyLocationPreludePrefix))
    return { layout: "legacy", location: text.slice(legacyLocationPreludePrefix.length) };
  return undefined;
}

/** Read from the last matching prelude up to the header, retaining original viewport indices. */
export function disclosureRows(
  lines: readonly string[],
  headerRow: number,
  layout: WorkspacePrelude["layout"],
): Row[] | undefined {
  const start = lines
    .slice(0, headerRow)
    .findLastIndex((line) => readWorkspacePrelude(line)?.layout === layout);
  if (start < 0) return undefined;

  return lines.slice(start, headerRow).flatMap((line, offset) => {
    const text = stripRowPadding(line);
    return text.length === 0 ? [] : [{ index: start + offset, text }];
  });
}

/** Verify the final target and any displayed launch location at the two-column inset. */
export function matchFolderAccessDisclosure(
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

/** Verify the opening launch alias and any inline or wrapped repository path at zero inset. */
export function matchLegacyDisclosure(
  rows: readonly Row[],
  { target: { targetPath, targetScope }, requiresRepositoryNote }: CheckedTrustTarget,
  launchDirectoryPaths: readonly string[],
  fits: RowFits,
): boolean {
  const [cwd, ...note] = rows;
  const cwdRowFits = cwd && fits({ rowIndex: cwd.index, rightInsetCols: 0 });
  if (!cwdRowFits) return false;
  const matchingAliases = launchDirectoryPaths.filter(
    (alias) => cwd.text === legacyLocationPreludePrefix + stripRowPadding(alias),
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
