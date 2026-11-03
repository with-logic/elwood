/** Shared owner/mode rules for replaceable path namespaces (PRD §8.1/§12A.5, C-STATE-11/C-CLI-15). */
import type { Stats } from "node:fs";

export type PathUser = { readonly uid: number; readonly gid: number };
const STICKY = 0o1000;
const GROUP_WRITE = 0o020;
const OTHER_WRITE = 0o002;

/** CLI-compatible mode-bit policy; ACLs and extra members of a private group are not inspected. */
export function lookupFault(
  info: Pick<Stats, "uid" | "gid" | "mode">,
  user: PathUser,
  directory: string,
): string | undefined {
  const owner = ownerFault(info, user, directory, "directory");
  if (owner !== undefined) return owner;
  const privateGroup = user.uid !== 0 && info.gid === user.gid && user.gid === user.uid;
  const writable =
    (info.mode & OTHER_WRITE) !== 0 || ((info.mode & GROUP_WRITE) !== 0 && !privateGroup);
  if (!writable || (info.mode & STICKY) !== 0) return undefined;
  return `directory '${directory}' is writable by other users; remove that with 'chmod go-w', or choose a workspace elsewhere`;
}

/** Sticky directories protect only entries belonging to the user or root. */
export function ownerFault(
  info: Pick<Stats, "uid">,
  user: PathUser,
  path: string,
  kind: "directory" | "link",
): string | undefined {
  if (info.uid === 0 || info.uid === user.uid) return undefined;
  return `${kind} '${path}' is owned by another user; choose a workspace reached only through your own or root's directories`;
}
