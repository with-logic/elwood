/** Capture and revalidate the local scope of Codex workspace trust (PRD §5.5). */
import { stat } from "node:fs/promises";
import { type DirectoryIdentity, sameDirectoryIdentity } from "../../core/directory-identity.ts";
import { boundedTrustEvidence } from "../../core/trust/evidence-deadline.ts";
import type { CheckedLaunchDirectory } from "../../runtime/session/launch-directory.ts";
import { canonicalGitPath } from "./git-paths.ts";
import { type CodexRepositoryTrustRoot, codexRepositoryTrustRoot } from "./repository.ts";

type TrustTarget = {
  readonly targetPath: string;
  readonly targetScope: "folder" | "repository";
};
type CheckedTrustTarget = {
  readonly target: TrustTarget;
  readonly identity: DirectoryIdentity;
  readonly physicalPath: string;
  /** A distinct checkout root needs the native repository note when folder fallback is possible. */
  readonly requiresRepositoryNote: boolean;
};
type LaunchPath = {
  readonly cwd: string;
  readonly repository: CodexRepositoryTrustRoot | undefined;
  readonly targets: readonly CheckedTrustTarget[];
};
export type CodexLaunchTrustEvidence = {
  readonly aliases: readonly string[];
  readonly targets: readonly CheckedTrustTarget[];
  readonly isCurrent: (signal?: AbortSignal) => Promise<boolean>;
};

/**
 * Capture exact path spellings and recheck directory identity and repository scope.
 * Startup uses captureStartupTrustEvidence to cap the wait.
 * Failed verification yields no paths or targets. A verified non-Git launch has a folder target.
 */
export async function captureLaunchTrustEvidence(
  directory: CheckedLaunchDirectory,
  signal?: AbortSignal,
): Promise<CodexLaunchTrustEvidence> {
  const paths = await captureLaunchTrustPaths(directory, signal);
  const physicalCwd = paths.at(-1)?.cwd;
  return {
    aliases: paths.map(({ cwd }) => cwd),
    targets: paths.flatMap(({ targets }) => targets),
    isCurrent: async (signal) => {
      if (
        physicalCwd === undefined ||
        !(await isSameDirectory(directory.cwd, directory.identity, physicalCwd, signal))
      )
        return false;
      for (const path of paths) {
        if (!(await isCurrentLaunchTrustPath(path, signal))) return false;
      }
      return !signal?.aborted;
    },
  };
}

/** Gate optional startup proof on a bounded wait while filesystem work proceeds asynchronously. */
export function captureStartupTrustEvidence(directory: CheckedLaunchDirectory) {
  return boundedTrustEvidence((signal) => captureLaunchTrustEvidence(directory, signal));
}

async function captureLaunchTrustPaths(
  directory: CheckedLaunchDirectory,
  signal: AbortSignal | undefined,
): Promise<readonly LaunchPath[]> {
  try {
    const physical = await canonicalGitPath(directory.cwd, signal);
    if (!(await isSameDirectory(physical, directory.identity, physical, signal))) return [];
    const scopes: LaunchPath[] = [];
    for (const cwd of new Set([directory.cwd, physical])) {
      const repository = await codexRepositoryTrustRoot(cwd, signal);
      // Codex may disclose either ancestor root when a symlink crosses repositories.
      const targets: CheckedTrustTarget[] = [];
      if (!repository || repository.allowsFolderFallback)
        targets.push(await checkTarget({ targetPath: cwd, targetScope: "folder" }, false, signal));
      if (repository && (!repository.allowsFolderFallback || repository.path !== cwd))
        targets.push(
          await checkTarget(
            { targetPath: repository.path, targetScope: "repository" },
            repository.allowsFolderFallback,
            signal,
          ),
        );
      scopes.push({ cwd, repository, targets });
    }
    return signal?.aborted ? [] : scopes;
  } catch {
    return [];
  }
}

async function checkTarget(
  target: TrustTarget,
  requiresRepositoryNote: boolean,
  signal: AbortSignal | undefined,
): Promise<CheckedTrustTarget> {
  signal?.throwIfAborted();
  return {
    target,
    identity: await stat(target.targetPath, { bigint: true }),
    physicalPath: await canonicalGitPath(target.targetPath, signal),
    requiresRepositoryNote,
  };
}

async function isCurrentLaunchTrustPath(
  { cwd, repository, targets }: LaunchPath,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    // Git metadata can redirect trust without replacing either directory.
    const current = await codexRepositoryTrustRoot(cwd, signal);
    if (
      current?.path !== repository?.path ||
      current?.allowsFolderFallback !== repository?.allowsFolderFallback
    )
      return false;
    for (const { target, identity, physicalPath } of targets) {
      if (!(await isSameDirectory(target.targetPath, identity, physicalPath, signal))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function isSameDirectory(
  path: string,
  expected: DirectoryIdentity | undefined,
  physicalPath: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (expected === undefined) return false;
  try {
    signal?.throwIfAborted();
    const current = await stat(path, { bigint: true });
    return (
      current.isDirectory() &&
      sameDirectoryIdentity(current, expected) &&
      (await canonicalGitPath(path, signal)) === physicalPath
    );
  } catch {
    return false;
  }
}
