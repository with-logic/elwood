/** Resolve the Git scope associated with a checked Claude launch (PRD §5.1). */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { sameDirectoryIdentity } from "../../core/directory-identity.ts";
import {
  matchesGitHeadMarkerShape,
  parseGitMetadataLine,
  readBoundedGitMetadata,
} from "../../core/git-metadata.ts";
import type { PathUser } from "../../core/path-trust.ts";
import {
  assertLaunchDirectoryUnchanged,
  type CheckedLaunchDirectory,
} from "../../runtime/session/launch-directory.ts";
import { trustedGitDirectoryPath, trustedGitFile } from "./path-trust.ts";

type WorkspaceTrustTarget = {
  readonly physicalLaunchPath: string;
  readonly targetPath: string;
  readonly targetScope: "folder" | "repository";
};

// HEAD and worktree pointers are short single lines. Decline longer evidence
// so a revalidation never reads more than 4 KiB per metadata file.
const maximumMetadataBytes = 4096;
const gitDirectoryPrefix = "gitdir: ";

/**
 * Capture the checked launch's scope before starting Claude. Every later read rechecks
 * that evidence. Missing or changed evidence permanently revokes the captured scope.
 */
export function captureClaudeWorkspaceTrustTarget(
  directory: CheckedLaunchDirectory,
): () => WorkspaceTrustTarget | undefined {
  let captured = verifyWorkspaceTarget(directory);
  return () => {
    if (!captured) return undefined;
    const verified = verifyWorkspaceTarget(directory);
    if (
      verified?.key !== captured.key ||
      !sameDirectoryIdentity(verified.identity, captured.identity)
    ) {
      captured = undefined;
      return undefined;
    }
    return verified.scope;
  };
}

function verifyWorkspaceTarget(directory: CheckedLaunchDirectory) {
  if (!directory.identity) return undefined;
  try {
    assertLaunchDirectoryUnchanged(directory);
    const scope = resolveClaudeWorkspaceTrustTarget(directory.cwd);
    if (!scope) return undefined;
    const identity = lstatSync(scope.targetPath, { bigint: true });
    if (!identity.isDirectory()) return undefined;
    assertLaunchDirectoryUnchanged({ ...directory, cwd: scope.physicalLaunchPath });
    if (scope.physicalLaunchPath !== directory.cwd) assertLaunchDirectoryUnchanged(directory);
    const key = [scope.physicalLaunchPath, scope.targetPath, scope.targetScope].join("\0");
    return { scope, key, identity };
  } catch {
    return undefined;
  }
}

/** Inspect the current directory and Git layout. Launch identity is checked at capture and revalidation. */
export function resolveClaudeWorkspaceTrustTarget(
  launchCwd: string,
): WorkspaceTrustTarget | undefined {
  if (!isAbsolute(launchCwd)) return undefined;
  try {
    const physicalLaunchPath = realpathSync(launchCwd);
    if (!lstatSync(physicalLaunchPath).isDirectory()) return undefined;

    const gitMarker = nearestGitMarker(physicalLaunchPath);
    if (!gitMarker)
      return { physicalLaunchPath, targetPath: physicalLaunchPath, targetScope: "folder" };

    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined) return undefined;
    const user = { uid, gid };
    if (!trustedGitDirectoryPath(gitMarker.directory, user)) return undefined;
    const targetPath = resolveRepositoryTarget(gitMarker, user);
    return targetPath === undefined
      ? undefined
      : { physicalLaunchPath, targetPath, targetScope: "repository" };
  } catch {
    // Inaccessible, disappearing, or unsupported Git metadata cannot attest a trust target.
    return undefined;
  }
}

function nearestGitMarker(physicalLaunchPath: string) {
  let directory = physicalLaunchPath;
  while (true) {
    const metadata = lstatSync(join(directory, ".git"), { throwIfNoEntry: false });
    if (metadata) return { directory, metadata };
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function resolveRepositoryTarget(
  gitMarker: NonNullable<ReturnType<typeof nearestGitMarker>>,
  user: PathUser,
): string | undefined {
  const { directory, metadata } = gitMarker;
  const marker = join(directory, ".git");
  if (metadata.isDirectory()) {
    return trustedGitDirectoryPath(marker, user) && hasValidGitHead(marker, user)
      ? directory
      : undefined;
  }
  if (!metadata.isFile()) return undefined;

  const pointer = readGitMetadata(marker, user);
  if (!pointer?.startsWith(gitDirectoryPrefix)) return undefined;
  const gitDir = resolveGitPointer(directory, pointer.slice(gitDirectoryPrefix.length), user);
  if (!(gitDir && hasValidGitHead(gitDir, user))) return undefined;

  const commonFile = join(gitDir, "commondir");
  if (
    !(
      lstatSync(commonFile, { throwIfNoEntry: false }) ||
      lstatSync(join(gitDir, "gitdir"), { throwIfNoEntry: false })
    )
  )
    return directory;
  return mainCheckout(gitDir, commonFile, marker, pointer, user);
}

function mainCheckout(
  gitDir: string,
  commonFile: string,
  marker: string,
  pointer: string,
  user: PathUser,
): string | undefined {
  const commonPointer = readGitMetadata(commonFile, user);
  const backlink = readGitMetadata(join(gitDir, "gitdir"), user);
  // Claude also treats backslashes as separators when it checks linked registration.
  if ([pointer, marker, gitDir, commonPointer, backlink].some((path) => path?.includes("\\")))
    return undefined;
  const commonDir = resolveGitPointer(gitDir, commonPointer, user);
  if (!commonDir) return undefined;
  const registeredLayout =
    basename(commonDir) === ".git" && dirname(gitDir) === join(commonDir, "worktrees");
  if (!(registeredLayout && hasValidGitHead(commonDir, user))) return undefined;

  // Git's reciprocal link identifies which checkout this administrative directory belongs to.
  return resolveGitPointer(gitDir, backlink, user, "file") === marker
    ? dirname(commonDir)
    : undefined;
}

function hasValidGitHead(gitDir: string, user: PathUser): boolean {
  const head = readGitMetadata(join(gitDir, "HEAD"), user);
  return head !== undefined && matchesGitHeadMarkerShape(head);
}

function resolveGitPointer(
  base: string,
  path: string | undefined,
  user: PathUser,
  kind: "directory" | "file" = "directory",
): string | undefined {
  if (!path || path.trim() !== path) return undefined;
  // Native lookup must reject a missing component in a pointer such as missing/../.git
  // before lexical normalization can erase it.
  const absolute = isAbsolute(path) ? path : `${base}${sep}${path}`;
  const canonical = realpathSync.native(absolute);
  const lookupPath = kind === "directory" ? absolute : absolute.slice(0, absolute.lastIndexOf(sep));
  return canonical === resolve(base, path) && trustedGitDirectoryPath(lookupPath, user)
    ? canonical
    : undefined;
}

function readGitMetadata(path: string, user: PathUser): string | undefined {
  const contents = readBoundedGitMetadata(path, maximumMetadataBytes, (info) =>
    trustedGitFile(info, user, path),
  );
  return parseGitMetadataLine(contents);
}
