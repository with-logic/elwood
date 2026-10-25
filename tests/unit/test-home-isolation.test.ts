/**
 * The Vitest preload gives each test file a private `HOME` and `CODEX_HOME` (PRD §12), so
 * code that resolves the user's Codex home from them cannot reach the developer's own
 * `~/.codex`, even after a test unsets `CODEX_HOME`. `userInfo()` reads the account
 * database, not `HOME`, so it still names the developer's real home.
 */

import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const realHome = userInfo().homedir;

test("HOME is a private directory, not the developer's home", () => {
  expect(homedir()).not.toBe(realHome);
  expect(homedir().startsWith(`${realHome}/`)).toBe(false);
});

test("CODEX_HOME is the private home's .codex, so unsetting it falls back to the same place", () => {
  expect(process.env["CODEX_HOME"]).toBe(join(homedir(), ".codex"));
});
