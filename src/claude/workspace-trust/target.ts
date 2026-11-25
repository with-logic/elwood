/** Capture and revalidate the physical scope associated with a checked Claude launch (PRD §5.1). */
import { lstat, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { type DirectoryIdentity, sameDirectoryIdentity } from "../../core/directory-identity.ts";
import { boundedTrustEvidence } from "../../core/trust/evidence-deadline.ts";
import { canonicalGitPath } from "../../core/trust/git-paths.ts";
import type { CheckedLaunchDirectory } from "../../runtime/session/launch-directory.ts";
import { trustedGitDirectoryPath } from "./path-trust.ts";
import { claudeRepositoryTarget, nearestGitMarker } from "./repository.ts";

type ClaudeWorkspaceTrustScope = {
  readonly physicalLaunchPath: string;
  readonly targetPath: string;
  readonly targetScope: "folder" | "repository";
};
export type ClaudeLaunchTrustEvidence = {
  readonly scope: ClaudeWorkspaceTrustScope;
  readonly isCurrent: (signal?: AbortSignal) => Promise<boolean>;
};

/** Capture launch and target identities before starting Claude. */
export async function captureClaudeWorkspaceTrustTarget(
  directory: CheckedLaunchDirectory,
  signal?: AbortSignal,
): Promise<ClaudeLaunchTrustEvidence | undefined> {
  const captured = await verifyWorkspaceTarget(directory, signal);
  if (!captured) return undefined;
  const { scope, key, identity } = captured;
  let current = true;
  return {
    scope,
    isCurrent: async (signal) => {
      if (!current) return false;
      const verified = await verifyWorkspaceTarget(directory, signal);
      if (signal?.aborted) return false;
      if (verified?.key !== key || !sameDirectoryIdentity(verified.identity, identity))
        current = false;
      return current;
    },
  };
}

export function captureClaudeStartupTrustEvidence(directory: CheckedLaunchDirectory) {
  return boundedTrustEvidence((signal) => captureClaudeWorkspaceTrustTarget(directory, signal));
}

async function verifyWorkspaceTarget(
  { cwd, identity: launchIdentity }: CheckedLaunchDirectory,
  signal: AbortSignal | undefined,
) {
  if (!launchIdentity) return undefined;
  try {
    if (!(await isLaunchDirectory(cwd, launchIdentity, signal))) return undefined;
    const scope = await resolveClaudeWorkspaceTrustTarget(cwd, signal);
    if (!scope) return undefined;
    signal?.throwIfAborted();
    const identity = await lstat(scope.targetPath, { bigint: true });
    if (!identity.isDirectory()) return undefined;
    if (!(await isLaunchDirectory(scope.physicalLaunchPath, launchIdentity, signal)))
      return undefined;
    if (scope.physicalLaunchPath !== cwd && !(await isLaunchDirectory(cwd, launchIdentity, signal)))
      return undefined;
    signal?.throwIfAborted();
    const key = [scope.physicalLaunchPath, scope.targetPath, scope.targetScope].join("\0");
    return { scope, key, identity };
  } catch {
    return undefined;
  }
}

async function isLaunchDirectory(
  path: string,
  identity: DirectoryIdentity,
  signal: AbortSignal | undefined,
) {
  signal?.throwIfAborted();
  const current = await stat(path, { bigint: true });
  return current.isDirectory() && sameDirectoryIdentity(current, identity);
}

/** Determine the directory Claude would trust from its workspace path and current Git metadata. */
export async function resolveClaudeWorkspaceTrustTarget(
  launchCwd: string,
  signal?: AbortSignal,
): Promise<ClaudeWorkspaceTrustScope | undefined> {
  if (!isAbsolute(launchCwd)) return undefined;
  try {
    const physicalLaunchPath = await canonicalGitPath(launchCwd, signal);
    signal?.throwIfAborted();
    if (!(await lstat(physicalLaunchPath)).isDirectory()) return undefined;
    const marker = await nearestGitMarker(physicalLaunchPath, signal);
    if (!marker)
      return { physicalLaunchPath, targetPath: physicalLaunchPath, targetScope: "folder" };
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined) return undefined;
    const user = { uid, gid };
    if (!(await trustedGitDirectoryPath(marker.directory, user, signal))) return undefined;
    const targetPath = await claudeRepositoryTarget(marker, user, signal);
    return targetPath === undefined
      ? undefined
      : { physicalLaunchPath, targetPath, targetScope: "repository" };
  } catch {
    // Inaccessible, disappearing, or unsupported Git metadata cannot attest a trust target.
    return undefined;
  }
}
