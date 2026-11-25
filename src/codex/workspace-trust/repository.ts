/** Corroborate local Codex repository trust scope from Git's on-disk layout (PRD §5.5). */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readBoundedGitMetadata } from "../../core/git-metadata.ts";

const maxGitMarkerBytes = 64 * 1024;
export type CodexRepositoryTrustRoot = {
  readonly path: string;
  readonly allowsFolderFallback: boolean;
};

/** Walk past empty .git directories as Codex does. Unproved metadata withholds trust. */
export function codexRepositoryTrustRoot(cwd: string): CodexRepositoryTrustRoot | undefined {
  for (let root = cwd; ; root = dirname(root)) {
    const git = join(root, ".git");
    const marker = lstatSync(git, { throwIfNoEntry: false });
    if (marker?.isFile()) return linkedRepositoryRoot(root, git);
    if (marker && !marker.isDirectory()) throw unprovedRepository();
    if (marker && lstatSync(join(git, "HEAD"), { throwIfNoEntry: false }))
      return { path: root, allowsFolderFallback: false };
    if (dirname(root) === root) return undefined;
  }
}

function linkedRepositoryRoot(checkout: string, marker: string): CodexRepositoryTrustRoot {
  const directory = gitFileTarget(marker);
  if (!lstatSync(directory).isDirectory()) throw unprovedRepository();
  const canonical = realpathSync.native(directory);
  const worktrees = dirname(canonical);
  if (basename(worktrees) !== "worktrees") {
    // Native versions can use the checkout root or launch folder for an ordinary gitfile.
    const head = readMarker(join(canonical, "HEAD"));
    if (!/^(?:ref: refs\/\S+|[a-f0-9]{40}(?:[a-f0-9]{24})?)$/i.test(head))
      throw unprovedRepository();
    return { path: checkout, allowsFolderFallback: true };
  }
  const common = dirname(worktrees);
  const backlink = resolve(canonical, readMarker(join(canonical, "gitdir")));
  const registered = realpathSync.native(dirname(backlink));
  const commonFromCheckout = realpathSync.native(
    resolve(canonical, readMarker(join(canonical, "commondir"))),
  );
  if (
    basename(backlink) !== ".git" ||
    registered !== realpathSync.native(checkout) ||
    commonFromCheckout !== common
  )
    throw unprovedRepository();

  const root = dirname(dirname(dirname(directory)));
  const mainMarker = join(root, ".git");
  const mainGit = lstatSync(mainMarker).isDirectory() ? mainMarker : gitFileTarget(mainMarker);
  if (realpathSync.native(mainGit) !== common) throw unprovedRepository();
  return { path: root, allowsFolderFallback: false };
}

function gitFileTarget(file: string): string {
  const contents = readMarker(file);
  const prefix = "gitdir:";
  if (!contents.startsWith(prefix)) throw unprovedRepository();
  const path = trimGitWhitespace(contents.slice(prefix.length));
  if (path.length === 0) throw unprovedRepository();
  return resolve(dirname(file), path);
}

function readMarker(file: string): string {
  const contents = readBoundedGitMetadata(file, maxGitMarkerBytes);
  if (contents === undefined) throw unprovedRepository();
  const path = trimGitWhitespace(contents);
  if (path.length === 0) throw unprovedRepository();
  return path;
}

function trimGitWhitespace(text: string): string {
  const whitespace = " \t\r\n\f";
  let start = 0;
  let end = text.length;
  while (start < end && whitespace.includes(text.charAt(start))) start += 1;
  while (end > start && whitespace.includes(text.charAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

function unprovedRepository(): Error {
  return new Error("Could not corroborate the Codex Git trust root");
}
