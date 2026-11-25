/** Resolve the Git scope associated with a checked Claude launch (PRD §5.1). */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { sameDirectoryIdentity } from "../../core/directory-identity.ts";
import { readBoundedGitMetadata } from "../../core/git-metadata.ts";
import {
  assertLaunchDirectoryUnchanged,
  type CheckedLaunchDirectory,
} from "../../runtime/session/launch-directory.ts";

type WorkspaceTrustTarget = {
  readonly launchPath: string;
  readonly targetPath: string;
  readonly targetScope: "folder" | "repository";
};

const maximumMetadataBytes = 4096;
const gitDirectoryPrefix = "gitdir: ";

/** Keep every later trust decision bound to the scope checked before the native launch. */
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
    const key = [scope.launchPath, scope.targetPath, scope.targetScope].join("\0");
    return { scope, key, identity };
  } catch {
    return undefined;
  }
}

/** Resolve only ordinary directories and Git layouts that identify their checkout unambiguously. */
export function resolveClaudeWorkspaceTrustTarget(
  launchCwd: string,
): WorkspaceTrustTarget | undefined {
  if (!isAbsolute(launchCwd)) return undefined;
  try {
    const launchPath = realpathSync(launchCwd);
    if (!lstatSync(launchPath).isDirectory()) return undefined;

    const repository = nearestGitMarker(launchPath);
    if (!repository) return { launchPath, targetPath: launchPath, targetScope: "folder" };

    const targetPath = resolveRepositoryTarget(repository);
    return targetPath === undefined
      ? undefined
      : { launchPath, targetPath, targetScope: "repository" };
  } catch {
    // Inaccessible, disappearing, or unsupported Git metadata cannot attest a trust target.
    return undefined;
  }
}

function nearestGitMarker(launchPath: string) {
  let directory = launchPath;
  while (true) {
    const metadata = lstatSync(join(directory, ".git"), { throwIfNoEntry: false });
    if (metadata) return { directory, metadata };
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function resolveRepositoryTarget(
  repository: NonNullable<ReturnType<typeof nearestGitMarker>>,
): string | undefined {
  const { directory, metadata } = repository;
  const marker = join(directory, ".git");
  if (metadata.isDirectory()) return gitHeadExists(marker) ? directory : undefined;
  if (!metadata.isFile()) return undefined;

  const pointer = readGitMetadata(marker);
  if (!pointer?.startsWith(gitDirectoryPrefix)) return undefined;
  const gitDir = resolveGitPointer(directory, pointer.slice(gitDirectoryPrefix.length));
  if (!gitDir || realpathSync(gitDir) !== gitDir || !gitHeadExists(gitDir)) return undefined;

  const commonFile = join(gitDir, "commondir");
  if (!lstatSync(commonFile, { throwIfNoEntry: false })) return directory;
  return mainCheckout(gitDir, commonFile, marker, pointer);
}

function mainCheckout(
  gitDir: string,
  commonFile: string,
  marker: string,
  pointer: string,
): string | undefined {
  const commonPointer = readGitMetadata(commonFile);
  const backlink = readGitMetadata(join(gitDir, "gitdir"));
  // Claude also treats backslashes as separators when it checks linked registration.
  if ([pointer, marker, gitDir, commonPointer, backlink].some((path) => path?.includes("\\")))
    return undefined;
  const commonDir = resolveGitPointer(gitDir, commonPointer);
  if (
    !commonDir ||
    basename(commonDir) !== ".git" ||
    dirname(gitDir) !== join(commonDir, "worktrees") ||
    !gitHeadExists(commonDir)
  )
    return undefined;

  // Git's reciprocal link identifies which checkout this administrative directory belongs to.
  return resolveGitPointer(gitDir, backlink) === marker ? dirname(commonDir) : undefined;
}

function gitHeadExists(gitDir: string): boolean {
  return lstatSync(join(gitDir, "HEAD"), { throwIfNoEntry: false })?.isFile() === true;
}

function resolveGitPointer(base: string, path: string | undefined): string | undefined {
  if (!path || path.trim() !== path) return undefined;
  return resolve(base, path);
}

function readGitMetadata(path: string): string | undefined {
  const value = readBoundedGitMetadata(path, maximumMetadataBytes)?.replace(/\r?\n$/, "");
  return value === undefined || /[\r\n\0]/.test(value) ? undefined : value;
}
