/** Filesystem identity shared by launch and probe boundaries (PRD §4.2, C-API-61). */
export type DirectoryIdentity = { readonly dev: bigint; readonly ino: bigint };
