/** Corroborate local Codex repository trust scope from Git's on-disk layout (PRD §5.5). */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import {
  matchesGitHeadMarkerShape,
  parseGitMetadataLine,
  readBoundedGitMetadata,
} from "../../core/git-metadata.ts";

// These metadata pointers are single lines. Bound the descriptor read before allocating.
const maxGitMarkerBytes = 64 * 1024;
export type CodexRepositoryTrustRoot = {
  readonly path: string;
  readonly allowsFolderFallback: boolean;
};

/** Walk past ancestor .git directories missing HEAD. Require valid Git evidence for trust. */
export function codexRepositoryTrustRoot(cwd: string): CodexRepositoryTrustRoot | undefined {
  for (let root = cwd; ; root = dirname(root)) {
    const git = join(root, ".git");
    const marker = lstatSync(git, { throwIfNoEntry: false });
    if (marker?.isFile()) return gitFileRepositoryRoot(root, git);
    if (marker && !marker.isDirectory()) throw unprovedRepository();
    const head = join(git, "HEAD");
    if (marker && lstatSync(head, { throwIfNoEntry: false })) {
      verifyHead(head);
      return { path: root, allowsFolderFallback: false };
    }
    if (dirname(root) === root) return undefined;
  }
}

function gitFileRepositoryRoot(
  checkout: string,
  marker: string,
): CodexRepositoryTrustRoot | undefined {
  const directory = gitFileTarget(marker);
  if (!lstatSync(directory).isDirectory()) throw unprovedRepository();
  const canonical = realpathSync.native(directory);
  const backlink = join(canonical, "gitdir");
  const commondir = join(canonical, "commondir");
  const hasBacklink = lstatSync(backlink, { throwIfNoEntry: false }) !== undefined;
  const hasCommonDir = lstatSync(commondir, { throwIfNoEntry: false }) !== undefined;
  if (!(hasBacklink || hasCommonDir)) {
    // An ordinary gitfile can disclose the checkout root or the exact launch folder.
    verifyHead(join(canonical, "HEAD"));
    return { path: checkout, allowsFolderFallback: true };
  }
  const worktrees = dirname(canonical);
  const registeredWorktreeLayout =
    hasBacklink && hasCommonDir && basename(worktrees) === "worktrees";
  if (!registeredWorktreeLayout) throw unprovedRepository();
  const common = dirname(worktrees);
  const registeredGitFile = absoluteGitPointer(canonical, readMarker(backlink));
  const registered = realpathSync.native(dirname(registeredGitFile));
  const commonFromCheckout = realpathSync.native(
    absoluteGitPointer(canonical, readMarker(commondir)),
  );
  const registrationMatchesCheckout =
    basename(registeredGitFile) === ".git" &&
    registered === realpathSync.native(checkout) &&
    commonFromCheckout === common;
  if (!registrationMatchesCheckout) throw unprovedRepository();

  const root = dirname(common);
  const mainMarker = join(root, ".git");
  const main = lstatSync(mainMarker, { throwIfNoEntry: false });
  // An external common directory cannot identify its main checkout from the worktree.
  if (!main) return undefined;
  const mainGit = main.isDirectory() ? mainMarker : gitFileTarget(mainMarker);
  if (realpathSync.native(mainGit) !== common) throw unprovedRepository();
  return { path: root, allowsFolderFallback: false };
}

function gitFileTarget(file: string): string {
  const contents = readMarker(file);
  const prefix = "gitdir: ";
  if (!contents.startsWith(prefix)) throw unprovedRepository();
  const path = contents.slice(prefix.length);
  if (path.length === 0) throw unprovedRepository();
  return absoluteGitPointer(dirname(file), path);
}

function absoluteGitPointer(base: string, pointer: string): string {
  // Let the filesystem traverse symlinks before interpreting subsequent dot-dot components.
  return isAbsolute(pointer) ? pointer : `${base}${sep}${pointer}`;
}

function verifyHead(file: string): void {
  if (!matchesGitHeadMarkerShape(readMarker(file))) throw unprovedRepository();
}

function readMarker(file: string): string {
  const contents = parseGitMetadataLine(readBoundedGitMetadata(file, maxGitMarkerBytes));
  if (contents === undefined) throw unprovedRepository();
  return contents;
}

function unprovedRepository(): Error {
  return new Error("Could not corroborate the Codex Git trust root");
}
