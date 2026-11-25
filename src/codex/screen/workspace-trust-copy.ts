/** Native text shared by Codex workspace trust and composer recognition (C-TRUST-01). */
export const legacyLocationPreludePrefix = "> You are in ";

export function isFolderAccessPrelude(row: string): boolean {
  return row.trim() === "Folder access";
}
