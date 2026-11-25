/** Match Codex's native folder-access disclosure to a checked launch target (PRD §5.5). */
import { isGenericTrustDialogFooter } from "../../core/trust/dialog.ts";
import { codexFolderAccessFooter, codexFolderAccessLabels } from "../../core/trust/options.ts";
import { trustView } from "../../core/trust/view.ts";
import type { TerminalSnapshot } from "../../terminal/headless.ts";

const repositoryNote =
  "Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:";
const legacyLocation = "> You are in ";
const folderAccess = {
  layout: "folder-access",
  acceptLabel: codexFolderAccessLabels.accept,
} as const;
const codexWorkspaceLayouts = [
  {
    layout: "legacy",
    acceptLabel: "Yes, continue",
    declineLabel: "No, quit",
    footer: "Press enter to continue",
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

type TrustTarget = {
  readonly targetPath: string;
  readonly targetScope: "folder" | "repository";
};
type CheckedTrustTarget = {
  readonly target: TrustTarget;
  readonly requiresRepositoryNote: boolean;
};
type LaunchEvidence = {
  readonly aliases: readonly string[];
  readonly targets: readonly CheckedTrustTarget[];
  readonly isCurrent: () => boolean;
};

type Row = { readonly index: number; readonly text: string };
type RowFits = (row: number, inset: number) => boolean;
type Layout = (typeof codexWorkspaceLayouts)[number]["layout"];

export type CodexTrustTargetResolver = (
  frame: Pick<TerminalSnapshot, "lines">,
  rowFits: RowFits,
) => TrustTarget | undefined;

/** Match a native frame against independent and revalidated launch evidence. */
export function createCodexTrustTargetResolver({
  aliases,
  targets,
  isCurrent,
}: LaunchEvidence): CodexTrustTargetResolver {
  return ({ lines }, rowFits) => {
    const menu = matchWorkspaceMenu(lines);
    if (!menu) return undefined;
    const { headerRow, layout } = menu;
    const prefix = disclosureRows(lines, headerRow, layout);
    if (!prefix) return undefined;

    let result: TrustTarget | undefined;
    for (const checked of targets) {
      const matches =
        layout === "folder-access"
          ? modernMatches(prefix, checked, aliases, rowFits)
          : legacyMatches(prefix, checked, aliases, rowFits);
      if (!matches) continue;
      if (
        result &&
        (result.targetPath !== checked.target.targetPath ||
          result.targetScope !== checked.target.targetScope)
      )
        return undefined;
      result = checked.target;
    }
    return result && isCurrent() ? result : undefined;
  };
}

function matchWorkspaceMenu(
  lines: readonly string[],
): { readonly headerRow: number; readonly layout: Layout } | undefined {
  const candidate = trustView(lines.join("\n"), "codex", () => false);
  if (candidate.kind !== "candidate" || !candidate.valid || candidate.spec.id !== "workspace_trust")
    return undefined;
  const [accept, decline, extra] = candidate.dialog.options;
  if (
    extra ||
    accept?.style !== "numbered" ||
    decline?.style !== "numbered" ||
    accept.number !== "1" ||
    decline.number !== "2" ||
    accept.selected === decline.selected
  )
    return undefined;
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
  return { headerRow: candidate.headerRow, layout: layout.layout };
}

function disclosureRows(lines: readonly string[], end: number, layout: Layout): Row[] | undefined {
  const start = lines.slice(0, end).findLastIndex((line) => {
    const text = line.trimStart();
    return layout === "folder-access"
      ? text.trimEnd() === "Folder access"
      : text.startsWith(legacyLocation);
  });
  if (start < 0) return undefined;

  return lines.slice(start, end).flatMap((line, offset) => {
    const text = stripRowPadding(line);
    return text.length === 0 ? [] : [{ index: start + offset, text }];
  });
}

function modernMatches(
  rows: readonly Row[],
  { target: { targetPath, targetScope }, requiresRepositoryNote }: CheckedTrustTarget,
  aliases: readonly string[],
  fits: RowFits,
): boolean {
  const targetRow = rows.at(-1);
  if (!(targetRow && fits(targetRow.index, 2)) || targetRow.text !== stripRowPadding(targetPath))
    return false;
  const details = rows.slice(1, -1);
  const [cwd] = details;
  if (!cwd) return !requiresRepositoryNote && aliases.includes(targetPath);
  if (targetScope !== "repository") return false;
  if (cwd.text.startsWith("/")) {
    const matchesAlias = aliases.some(
      (alias) => alias !== targetPath && cwd.text === stripRowPadding(alias),
    );
    return fits(cwd.index, 2) && matchesAlias && noteText(details.slice(1)) === repositoryNote;
  }
  return aliases.some((alias) => alias !== targetPath) && noteText(details) === repositoryNote;
}

function legacyMatches(
  rows: readonly Row[],
  { target: { targetPath, targetScope }, requiresRepositoryNote }: CheckedTrustTarget,
  aliases: readonly string[],
  fits: RowFits,
): boolean {
  const [cwd, ...note] = rows;
  if (!(cwd && fits(cwd.index, 0))) return false;
  const matchingAliases = aliases.filter(
    (alias) => cwd.text === legacyLocation + stripRowPadding(alias),
  );
  if (note.length === 0) return !requiresRepositoryNote && matchingAliases.includes(targetPath);
  return (
    targetScope === "repository" &&
    matchingAliases.some((alias) => alias !== targetPath) &&
    noteText(note) === `${repositoryNote} ${stripRowPadding(targetPath)}` &&
    legacyPathRowsFit(note, fits)
  );
}

/** The legacy disclosure joins the note and the path, so a row may contain both. */
function legacyPathRowsFit(note: readonly Row[], fits: RowFits): boolean {
  let pathOffset = repositoryNote.length + 1;
  for (const { index, text } of note) {
    if (text.length > pathOffset && !fits(index, 0)) return false;
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
