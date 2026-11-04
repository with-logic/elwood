/** Shared directory comparison requires both identity fields (PRD §4.2, C-API-61). */
import { expect, test } from "vitest";
import { sameDirectoryIdentity } from "../../src/core/directory-identity.ts";

test.each([
  ["matching", 1n, 2n, true],
  ["different device", 3n, 2n, false],
  ["different inode", 1n, 4n, false],
] as const)("C-API-61 compares both directory fields: %s", (_name, dev, ino, expected) => {
  expect(sameDirectoryIdentity({ dev: 1n, ino: 2n }, { dev, ino })).toBe(expected);
});
