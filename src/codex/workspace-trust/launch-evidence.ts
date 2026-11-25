/** Capture and revalidate the local scope of Codex workspace trust (PRD §5.5). */
import { realpathSync, statSync } from "node:fs";
import { type DirectoryIdentity, sameDirectoryIdentity } from "../../core/directory-identity.ts";
import type { CheckedLaunchDirectory } from "../../runtime/session/launch-directory.ts";
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
  readonly isCurrent: () => boolean;
};

/**
 * Capture exact path spellings and recheck directory identity and repository scope.
 * Failed verification yields no paths or targets. A verified non-Git launch has a folder target.
 */
export function captureLaunchTrustEvidence(
  directory: CheckedLaunchDirectory,
): CodexLaunchTrustEvidence {
  const paths = captureLaunchTrustPaths(directory);
  const physicalCwd = paths.at(-1)?.cwd;
  return {
    aliases: paths.map(({ cwd }) => cwd),
    targets: paths.flatMap(({ targets }) => targets),
    isCurrent: () =>
      physicalCwd !== undefined &&
      isSameDirectory(directory.cwd, directory.identity, physicalCwd) &&
      paths.every(isCurrentLaunchTrustPath),
  };
}

function captureLaunchTrustPaths(directory: CheckedLaunchDirectory): readonly LaunchPath[] {
  try {
    const physical = realpathSync.native(directory.cwd);
    if (!isSameDirectory(physical, directory.identity)) return [];
    return [...new Set([directory.cwd, physical])].map((cwd) => {
      const repository = codexRepositoryTrustRoot(cwd);
      // Codex may disclose either ancestor root when a symlink crosses repositories.
      const targets: CheckedTrustTarget[] = [];
      if (!repository || repository.allowsFolderFallback)
        targets.push(checkTarget({ targetPath: cwd, targetScope: "folder" }, false));
      if (repository && (!repository.allowsFolderFallback || repository.path !== cwd))
        targets.push(
          checkTarget(
            { targetPath: repository.path, targetScope: "repository" },
            repository.allowsFolderFallback,
          ),
        );
      return { cwd, repository, targets };
    });
  } catch {
    return [];
  }
}

function checkTarget(target: TrustTarget, requiresRepositoryNote: boolean): CheckedTrustTarget {
  return {
    target,
    identity: statSync(target.targetPath, { bigint: true }),
    physicalPath: realpathSync.native(target.targetPath),
    requiresRepositoryNote,
  };
}

function isCurrentLaunchTrustPath({ cwd, repository, targets }: LaunchPath): boolean {
  try {
    // Git metadata can redirect trust without replacing either directory.
    const current = codexRepositoryTrustRoot(cwd);
    return (
      current?.path === repository?.path &&
      current?.allowsFolderFallback === repository?.allowsFolderFallback &&
      targets.every(({ target, identity, physicalPath }) =>
        isSameDirectory(target.targetPath, identity, physicalPath),
      )
    );
  } catch {
    return false;
  }
}

function isSameDirectory(
  path: string,
  expected: DirectoryIdentity | undefined,
  physicalPath = path,
): boolean {
  if (expected === undefined) return false;
  try {
    const current = statSync(path, { bigint: true });
    return (
      current.isDirectory() &&
      sameDirectoryIdentity(current, expected) &&
      realpathSync.native(path) === physicalPath
    );
  } catch {
    return false;
  }
}
