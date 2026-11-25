/** Verify Claude's Git trust scope, including linked checkout registration (PRD §5.1). */
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  matchesGitHeadMarkerShape,
  parseGitMetadataLine,
  readBoundedGitMetadataAsync,
} from "../../core/git-metadata.ts";
import type { PathUser } from "../../core/path-trust.ts";
import { canonicalGitPath, lstatGitPath } from "../../core/trust/git-paths.ts";
import { trustedGitDirectoryPath, trustedGitFile } from "./path-trust.ts";

// HEAD and worktree pointers are short single lines.
const maximumMetadataBytes = 4096;
const gitDirectoryPrefix = "gitdir: ";

export async function nearestGitMarker(
  physicalLaunchPath: string,
  signal: AbortSignal | undefined,
) {
  let directory = physicalLaunchPath;
  while (true) {
    const metadata = await lstatGitPath(join(directory, ".git"), signal);
    if (metadata) return { directory, metadata };
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export async function claudeRepositoryTarget(
  { directory, metadata }: NonNullable<Awaited<ReturnType<typeof nearestGitMarker>>>,
  user: PathUser,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const marker = join(directory, ".git");
  if (metadata.isDirectory()) {
    return (await trustedGitDirectoryPath(marker, user, signal)) &&
      (await hasValidGitHead(marker, user, signal))
      ? directory
      : undefined;
  }
  if (!metadata.isFile()) return undefined;

  const pointer = await readGitMetadata(marker, user, signal);
  if (!pointer?.startsWith(gitDirectoryPrefix)) return undefined;
  const gitDir = await resolveGitPointer(
    directory,
    pointer.slice(gitDirectoryPrefix.length),
    user,
    signal,
  );
  if (!(gitDir && (await hasValidGitHead(gitDir, user, signal)))) return undefined;

  const commonFile = join(gitDir, "commondir");
  if (
    !(
      (await lstatGitPath(commonFile, signal)) ||
      (await lstatGitPath(join(gitDir, "gitdir"), signal))
    )
  )
    return directory;
  return await mainCheckout(gitDir, commonFile, marker, pointer, user, signal);
}

async function mainCheckout(
  gitDir: string,
  commonFile: string,
  marker: string,
  pointer: string,
  user: PathUser,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const commonPointer = await readGitMetadata(commonFile, user, signal);
  const backlink = await readGitMetadata(join(gitDir, "gitdir"), user, signal);
  // Claude also treats backslashes as separators when it checks linked registration.
  if ([pointer, marker, gitDir, commonPointer, backlink].some((path) => path?.includes("\\")))
    return undefined;
  const commonDir = await resolveGitPointer(gitDir, commonPointer, user, signal);
  if (!commonDir) return undefined;
  const registeredLayout =
    basename(commonDir) === ".git" && dirname(gitDir) === join(commonDir, "worktrees");
  if (!(registeredLayout && (await hasValidGitHead(commonDir, user, signal)))) return undefined;

  // Git's reciprocal link identifies which checkout this administrative directory belongs to.
  return (await resolveGitPointer(gitDir, backlink, user, signal, "file")) === marker
    ? dirname(commonDir)
    : undefined;
}

async function hasValidGitHead(
  gitDir: string,
  user: PathUser,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const head = await readGitMetadata(join(gitDir, "HEAD"), user, signal);
  return head !== undefined && matchesGitHeadMarkerShape(head);
}

async function resolveGitPointer(
  base: string,
  path: string | undefined,
  user: PathUser,
  signal: AbortSignal | undefined,
  kind: "directory" | "file" = "directory",
): Promise<string | undefined> {
  if (!path || path.trim() !== path) return undefined;
  // Native lookup must check components before lexical normalization can erase them.
  const absolute = isAbsolute(path) ? path : `${base}${sep}${path}`;
  const canonical = await canonicalGitPath(absolute, signal);
  const lookupPath = kind === "directory" ? absolute : absolute.slice(0, absolute.lastIndexOf(sep));
  return canonical === resolve(base, path) &&
    (await trustedGitDirectoryPath(lookupPath, user, signal))
    ? canonical
    : undefined;
}

async function readGitMetadata(path: string, user: PathUser, signal: AbortSignal | undefined) {
  const contents = await readBoundedGitMetadataAsync(path, maximumMetadataBytes, signal, (info) =>
    trustedGitFile(info, user, path),
  );
  return parseGitMetadataLine(contents);
}
