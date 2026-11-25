/** Corroborate the local namespaces carrying Claude's Git trust evidence (PRD §5.1). */
import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { lookupFault, type PathUser } from "../../core/path-trust.ts";

/** Check each directory the pointer actually traverses, including components before `..`. */
export async function trustedGitDirectoryPath(
  absolute: string,
  user: PathUser,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  let current: string = sep;
  signal?.throwIfAborted();
  if (lookupFault(await lstat(current), user, current) !== undefined) return false;
  for (const component of absolute.split(sep).filter(Boolean)) {
    if (component === "..") {
      current = dirname(current);
      continue;
    }
    current = join(current, component);
    signal?.throwIfAborted();
    const info = await lstat(current);
    if (!info.isDirectory() || lookupFault(info, user, current) !== undefined) return false;
  }
  return true;
}

/** A sticky bit protects directory entries, not the contents of a writable file. */
export function trustedGitFile(info: Stats, user: PathUser, path: string): boolean {
  const { uid, gid, mode } = info;
  return lookupFault({ uid, gid, mode: mode & ~0o1000 }, user, path) === undefined;
}
