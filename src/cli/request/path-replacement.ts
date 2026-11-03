/**
 * Looks for a way another user could change what a workspace path resolves to between
 * validation and launch. Implements PRD §12A.5 and C-CLI-15.
 *
 * The path is resolved name by name, as the kernel resolves it at spawn, following each symlink.
 * Every directory a name is looked up in must be owned by root or the user and not writable by
 * group or others, unless it is sticky or its group is the user's private group; every
 * directory and symlink passed must be owned by root or the user, since a sticky directory lets
 * other users rename their own entries. Finding nothing means only that these owner and
 * mode-bit checks found nothing: an ACL that grants another user write access, or another
 * member of the user's private group, is not seen. A path whose links cannot be followed
 * safely fails with a `PathInspectionError` that names the link.
 */

import { isUtf8 } from "node:buffer";
import { lstat, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { lookupFault, ownerFault, type PathUser } from "../../core/path-trust.ts";

export { lookupFault, type PathUser } from "../../core/path-trust.ts";

/** The path's links cannot be followed safely; the message names the link and the fix. */
export class PathInspectionError extends Error {
  override readonly name = "PathInspectionError";
}

/** As many symlinks as Linux follows in one path; a loop fails as uninspectable. */
const MAX_LINKS = 40;

/**
 * The first reason another user could redirect `path`, naming the directory or link that lets
 * them, or `undefined` when the owner and mode-bit checks find none. A link the walk cannot
 * follow throws a `PathInspectionError`, even past such a reason. The workspace itself is the
 * caller's to check.
 */
export async function pathReplacementReason(
  path: string,
  user: PathUser,
): Promise<string | undefined> {
  let current = "/";
  let fault = lookupFault(await lstat(current), user, current);
  const pending = namesOf(path);
  let links = 0;
  // The walk goes on past the first fault, which it keeps, so a link it cannot follow is still
  // named rather than left for `stat` to fail on.
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (name === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, name);
    const info = await lstat(next);
    if (info.isSymbolicLink()) {
      fault ??= ownerFault(info, user, next, "link");
      if (++links > MAX_LINKS)
        throw new PathInspectionError(
          `symbolic link '${next}' is past the ${MAX_LINKS} links a path may follow, as in a loop; fix the links, or choose a workspace reached without them`,
        );
      const target = await linkTarget(next);
      pending.push(...namesOf(target));
      if (isAbsolute(target)) current = "/";
      continue;
    }
    // The last name is the workspace; every other one is a directory the next name is looked in.
    if (pending.length > 0) fault ??= lookupFault(info, user, next);
    current = next;
  }
  return fault;
}

/**
 * The target of the link at `path`. One that is not UTF-8 fails: decoded, it would name another
 * path than the bytes the kernel follows, so the walk could check the wrong directories.
 */
async function linkTarget(path: string): Promise<string> {
  const bytes = await readlink(path, { encoding: "buffer" });
  if (!isUtf8(bytes))
    throw new PathInspectionError(
      `symbolic link '${path}' does not point to a UTF-8 path; point it at one, or choose a workspace reached without it`,
    );
  return bytes.toString("utf8");
}

/** The names of `path`, last first, so the next one to resolve is popped. */
function namesOf(path: string): string[] {
  return path
    .split("/")
    .filter((name) => name !== "" && name !== ".")
    .reverse();
}
