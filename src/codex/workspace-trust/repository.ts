/** Corroborate local Codex repository trust scope from Git's on-disk layout (PRD §5.5). */
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import {
  matchesGitHeadMarkerShape,
  parseGitMetadataLine,
  readBoundedGitMetadataAsync,
} from "../../core/git-metadata.ts";
import { canonicalGitPath, lstatGitPath } from "../../core/trust/git-paths.ts";

// These metadata pointers are single lines. Bound the descriptor read before allocating.
const maxGitMarkerBytes = 64 * 1024;
export type CodexRepositoryTrustRoot = {
  readonly path: string;
  readonly allowsFolderFallback: boolean;
};

/** Walk past ancestor .git directories missing HEAD. Require valid Git evidence for trust. */
export async function codexRepositoryTrustRoot(
  cwd: string,
  signal?: AbortSignal,
): Promise<CodexRepositoryTrustRoot | undefined> {
  for (let root = cwd; ; root = dirname(root)) {
    const git = join(root, ".git");
    const marker = await lstatGitPath(git, signal);
    if (marker?.isFile()) return await gitFileRepositoryRoot(root, git, signal);
    if (marker && !marker.isDirectory()) throw unprovedRepository();
    const head = join(git, "HEAD");
    if (marker && (await lstatGitPath(head, signal))) {
      await verifyHead(head, signal);
      return { path: root, allowsFolderFallback: false };
    }
    if (dirname(root) === root) return undefined;
  }
}

async function gitFileRepositoryRoot(
  checkout: string,
  marker: string,
  signal: AbortSignal | undefined,
): Promise<CodexRepositoryTrustRoot | undefined> {
  const directory = await gitFileTarget(marker, signal);
  if (!(await lstatGitPath(directory, signal))?.isDirectory()) throw unprovedRepository();
  const canonical = await canonicalGitPath(directory, signal);
  const backlink = join(canonical, "gitdir");
  const commondir = join(canonical, "commondir");
  const hasBacklink = (await lstatGitPath(backlink, signal)) !== undefined;
  const hasCommonDir = (await lstatGitPath(commondir, signal)) !== undefined;
  if (!(hasBacklink || hasCommonDir)) {
    // An ordinary gitfile can disclose the checkout root or the exact launch folder.
    await verifyHead(join(canonical, "HEAD"), signal);
    return { path: checkout, allowsFolderFallback: true };
  }
  const worktrees = dirname(canonical);
  const registeredWorktreeLayout =
    hasBacklink && hasCommonDir && basename(worktrees) === "worktrees";
  if (!registeredWorktreeLayout) throw unprovedRepository();
  const common = dirname(worktrees);
  const registeredGitFile = absoluteGitPointer(canonical, await readMarker(backlink, signal));
  const registered = await canonicalGitPath(dirname(registeredGitFile), signal);
  const commonFromCheckout = await canonicalGitPath(
    absoluteGitPointer(canonical, await readMarker(commondir, signal)),
    signal,
  );
  const registrationMatchesCheckout =
    basename(registeredGitFile) === ".git" &&
    registered === (await canonicalGitPath(checkout, signal)) &&
    commonFromCheckout === common;
  if (!registrationMatchesCheckout) throw unprovedRepository();

  const root = dirname(common);
  const mainMarker = join(root, ".git");
  const main = await lstatGitPath(mainMarker, signal);
  // An external common directory cannot identify its main checkout from the worktree.
  if (!main) return undefined;
  const mainGit = main.isDirectory() ? mainMarker : await gitFileTarget(mainMarker, signal);
  if ((await canonicalGitPath(mainGit, signal)) !== common) throw unprovedRepository();
  return { path: root, allowsFolderFallback: false };
}

async function gitFileTarget(file: string, signal: AbortSignal | undefined): Promise<string> {
  const contents = await readMarker(file, signal);
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

/** Accept a symbolic ref or a detached SHA-1 or SHA-256 object ID. */
async function verifyHead(file: string, signal: AbortSignal | undefined): Promise<void> {
  if (!matchesGitHeadMarkerShape(await readMarker(file, signal))) throw unprovedRepository();
}

async function readMarker(file: string, signal: AbortSignal | undefined): Promise<string> {
  const value = parseGitMetadataLine(
    await readBoundedGitMetadataAsync(file, maxGitMarkerBytes, signal),
  );
  if (value === undefined) throw unprovedRepository();
  return value;
}

function unprovedRepository(): Error {
  return new Error("Could not corroborate the Codex Git trust root");
}
