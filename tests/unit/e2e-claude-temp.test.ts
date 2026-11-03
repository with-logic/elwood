/**
 * How the e2e suite names and keeps Claude's temp root (`tests/e2e/claude-temp.ts`, PRD §12,
 * C-E2E-23, C-E2E-18).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  claudeTempFolder,
  claudeTempFoldersNamed,
  claudeTempKey,
  isNestedClaudeVariable,
} from "../e2e/claude-temp.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("C-E2E-23 the suite drops a parent Claude's variables but keeps the temp root", () => {
  expect(claudeTempKey).toBe("CLAUDE_CODE_TMPDIR");
  const keys = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", claudeTempKey, "CLAUDE_CONFIG_DIR"];
  expect(keys.filter(isNestedClaudeVariable)).toEqual(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]);
});

test("C-E2E-23 finds the temp folder Claude names for a working directory", () => {
  const folder = claudeTempFolder("/private/var/T/elwood_e2e_claude-a.B9");
  expect(folder).toBe("-private-var-T-elwood-e2e-claude-a-B9");
  const root = mkdtempSync(join(tmpdir(), "claude-temp-"));
  roots.push(root);
  expect(claudeTempFoldersNamed(root, folder)).toEqual([]); // no per-user folder yet
  const user = join(root, `claude-${process.getuid?.() ?? 0}`);
  mkdirSync(join(user, `${folder}-other`), { recursive: true });
  expect(claudeTempFoldersNamed(root, folder)).toEqual([]);
  mkdirSync(join(user, folder));
  expect(claudeTempFoldersNamed(root, folder)).toEqual([folder]);
});
