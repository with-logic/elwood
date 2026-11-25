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
  readonly requiresRepositoryNote: boolean;
};
type LaunchPath = {
  readonly cwd: string;
  readonly repository: CodexRepositoryTrustRoot | undefined;
  readonly targets: readonly CheckedTrustTarget[];
};

/** Preserve exact path spellings and detect later filesystem changes. */
export function captureLaunchTrustEvidence(directory: CheckedLaunchDirectory) {
  const paths = captureLaunchTrustPaths(directory);
  return {
    aliases: paths.map(({ cwd }) => cwd),
    targets: paths.flatMap(({ targets }) => targets),
    isCurrent: () =>
      paths.length > 0 &&
      isSameDirectory(directory.cwd, directory.identity) &&
      paths.every(isCurrentLaunchTrustPath),
  };
}

function captureLaunchTrustPaths(directory: CheckedLaunchDirectory): readonly LaunchPath[] {
  try {
    const physical = realpathSync.native(directory.cwd);
    if (!isSameDirectory(physical, directory.identity)) return [];
    return [...new Set([directory.cwd, physical])].map((cwd) => {
      const repository = codexRepositoryTrustRoot(cwd);
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
      targets.every(({ target, identity }) => isSameDirectory(target.targetPath, identity))
    );
  } catch {
    return false;
  }
}

function isSameDirectory(path: string, expected: DirectoryIdentity | undefined): boolean {
  if (expected === undefined) return false;
  try {
    const current = statSync(path, { bigint: true });
    return current.isDirectory() && sameDirectoryIdentity(current, expected);
  } catch {
    return false;
  }
}
