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
function disclosureRows(
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

type WorkspaceDisclosure =
  | { readonly kind: "folder"; readonly targetPath: string }
  | {
      readonly kind: "repository";
      readonly targetPath: string;
      readonly launchPath?: string;
    };

/** Parse native disclosure shape and row geometry independently of launch scope. */
export function parseWorkspaceDisclosure(
  lines: readonly string[],
  headerRow: number,
  layout: WorkspacePrelude["layout"],
  fits: RowFits,
): WorkspaceDisclosure | undefined {
  const [prelude, ...details] = disclosureRows(lines, headerRow, layout) ?? [];
  if (!prelude) return undefined;
  switch (layout) {
    case "folder access":
      return parseFolderAccess(details, fits);
    case "legacy":
      return parseLegacy(prelude, details, fits);
  }
}

/** Recognize visible path text that can veto a pending answer without verifying its target. */
export function hasCompleteWorkspaceDisclosure(
  lines: readonly string[],
  headerRow: number,
  layout: WorkspacePrelude["layout"],
  fits: RowFits,
): boolean {
  const disclosure = parseWorkspaceDisclosure(lines, headerRow, layout, fits);
  return (
    disclosure !== undefined &&
    !disclosure.targetPath.includes("…") &&
    (disclosure.kind === "folder" || !disclosure.launchPath?.includes("…"))
  );
}

export function matchesLaunchDisclosure(
  disclosure: WorkspaceDisclosure,
  { target: { targetPath, targetScope }, requiresRepositoryNote }: CheckedTrustTarget,
  launchDirectoryPaths: readonly string[],
): boolean {
  if (disclosure.targetPath !== stripRowPadding(targetPath)) return false;
  if (disclosure.kind === "folder")
    return !requiresRepositoryNote && launchDirectoryPaths.includes(targetPath);
  const { launchPath } = disclosure;
  return (
    targetScope === "repository" &&
    launchDirectoryPaths.some(
      (alias) =>
        alias !== targetPath && (launchPath === undefined || stripRowPadding(alias) === launchPath),
    )
  );
}

function parseFolderAccess(
  details: readonly Row[],
  fits: RowFits,
): WorkspaceDisclosure | undefined {
  const target = details.at(-1);
  if (!(target?.text.startsWith("/") && fits({ rowIndex: target.index, rightInsetCols: 2 })))
    return undefined;
  const beforeTarget = details.slice(0, -1);
  const [first, ...note] = beforeTarget;
  const targetPath = target.text;
  if (!first) return { kind: "folder", targetPath };
  if (noteText(beforeTarget) === repositoryNote) return { kind: "repository", targetPath };
  if (
    first.text.startsWith("/") &&
    noteText(note) === repositoryNote &&
    fits({ rowIndex: first.index, rightInsetCols: 2 })
  )
    return { kind: "repository", targetPath, launchPath: first.text };
  return undefined;
}

function parseLegacy(
  prelude: Row,
  note: readonly Row[],
  fits: RowFits,
): WorkspaceDisclosure | undefined {
  const launchPath = prelude.text.slice(legacyLocationPreludePrefix.length);
  if (!(launchPath.startsWith("/") && fits({ rowIndex: prelude.index, rightInsetCols: 0 })))
    return undefined;
  if (note.length === 0) return { kind: "folder", targetPath: launchPath };
  const disclosure = noteText(note);
  const rootPrefix = `${repositoryNote} `;
  if (!disclosure.startsWith(rootPrefix)) return undefined;
  const targetPath = disclosure.slice(rootPrefix.length);
  if (targetPath.startsWith("/") && legacyPathRowsFit(note, fits))
    return { kind: "repository", targetPath, launchPath };
  return undefined;
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
