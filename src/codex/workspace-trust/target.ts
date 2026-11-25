/** Match Codex's native folder-access disclosure to a checked launch target (PRD §5.5). */
import { codexFolderAccessFooter } from "../../core/trust/options.ts";
import type { TrustCandidate } from "../../core/trust/view.ts";
import type { TerminalSnapshot } from "../../terminal/headless.ts";

const repositoryNote =
  "Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:";
const legacyLocation = "> You are in ";
const folderAccess = { layout: "folder-access", acceptLabel: "Trust and continue" } as const;
const codexWorkspaceLayouts = [
  {
    layout: "legacy",
    acceptLabel: "Yes, continue",
    declineLabel: "No, quit",
    footer: "Press enter to continue",
  },
  { ...folderAccess, declineLabel: "Quit", footer: "enter continue · esc quit" },
  {
    ...folderAccess,
    declineLabel: "Back to Agent Command Center",
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
  candidate: TrustCandidate,
  rowFits: RowFits,
) => TrustTarget | undefined;

/** Match a native frame against independent and revalidated launch evidence. */
export function createCodexTrustTarget({
  aliases,
  targets,
  isCurrent,
}: LaunchEvidence): CodexTrustTargetResolver {
  return ({ lines }, candidate, rowFits) => {
    const layout = matchWorkspaceMenuLayout(candidate, lines);
    if (!layout) return undefined;
    const prefix = disclosureRows(lines, candidate, layout);
    if (!prefix) return undefined;

    let result: TrustTarget | undefined;
    for (const checked of targets) {
      const matches =
        layout === "folder-access"
          ? modernMatches(prefix, checked, aliases, rowFits)
          : legacyMatches(prefix, checked, aliases, rowFits);
      if (!matches) continue;
      if (result && result.targetPath !== checked.target.targetPath) return undefined;
      result = checked.target;
    }
    return result && isCurrent() ? result : undefined;
  };
}

function matchWorkspaceMenuLayout(
  candidate: TrustCandidate,
  lines: readonly string[],
): Layout | undefined {
  if (
    !candidate.valid ||
    candidate.spec.id !== "workspace_trust" ||
    candidate.spec.agent !== "codex"
  )
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
  return codexWorkspaceLayouts.find(
    (layout) =>
      layout.acceptLabel === accept.label &&
      layout.declineLabel === decline.label &&
      layout.footer === footer,
  )?.layout;
}

function disclosureRows(
  lines: readonly string[],
  candidate: TrustCandidate,
  layout: Layout,
): Row[] | undefined {
  const end = candidate.startRow;
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
  const root = rows.at(-1);
  if (!(root && fits(root.index, 2)) || root.text !== stripRowPadding(targetPath)) return false;
  const details = rows.slice(1, -1);
  if (details.length === 0) return !requiresRepositoryNote && aliases.includes(targetPath);
  if (targetScope !== "repository") return false;
  const [cwd, ...rest] = details;
  if (cwd?.text.startsWith("/")) {
    const matchesAlias = aliases.some(
      (alias) => alias !== targetPath && cwd.text === stripRowPadding(alias),
    );
    return fits(cwd.index, 2) && matchesAlias && noteText(rest) === repositoryNote;
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
  const final = note.at(-1);
  if (!final) return !requiresRepositoryNote && matchingAliases.includes(targetPath);
  return (
    targetScope === "repository" &&
    matchingAliases.some((alias) => alias !== targetPath) &&
    fits(final.index, 0) &&
    noteText(note) === `${repositoryNote} ${stripRowPadding(targetPath)}`
  );
}

function noteText(rows: readonly Row[]): string {
  return rows.map(({ text }) => text).join(" ");
}

/** Ratatui can pad with ASCII spaces. Only independently verified paths supply exact bytes. */
function stripRowPadding(text: string): string {
  return text.replace(/^ +| +$/g, "");
}
