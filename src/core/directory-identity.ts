/** Filesystem identity shared by launch and probe boundaries (PRD §4.2, C-API-61). */
export type DirectoryIdentity = { readonly dev: bigint; readonly ino: bigint };

/** A captured directory matches only when both device and inode are unchanged. */
export function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
