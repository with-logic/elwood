/** Exercise the private Git scope proof for a checked launch directory (PRD §5.1). */
import { lstatSync, mkdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { captureClaudeWorkspaceTrustTarget } from "../../src/claude/workspace-trust/target.ts";
import { tempDir } from "../helpers/tmp.ts";

vi.mock("node:fs", { spy: true });

function capture(cwd: string) {
  return captureClaudeWorkspaceTrustTarget({
    agent: "claude",
    cwd,
    identity: statSync(cwd, { bigint: true }),
  });
}

test("Claude workspace evidence requires a checked launch identity", () => {
  const readTarget = captureClaudeWorkspaceTrustTarget({
    agent: "claude",
    cwd: tempDir(),
    identity: undefined,
  });
  expect(readTarget()).toBeUndefined();
});

test("Claude workspace evidence requires resolvable Git metadata", () => {
  const cwd = realpathSync(tempDir());
  writeFileSync(join(cwd, ".git"), "unrecognized metadata\n");
  expect(capture(cwd)()).toBeUndefined();
});

test("moving the checked launch directory revokes its scope", () => {
  const parent = realpathSync(tempDir());
  const cwd = join(parent, "checked");
  mkdirSync(cwd);
  const readTarget = capture(cwd);
  renameSync(cwd, join(parent, "moved"));
  expect(readTarget()).toBeUndefined();
});

test.each([
  "file",
  "directory",
])("replacing the checked target with another %s revokes scope", async (kind) => {
  const cwd = realpathSync(tempDir());
  const readTarget = capture(cwd);
  expect(readTarget()).toEqual({ launchPath: cwd, targetPath: cwd, targetScope: "folder" });

  const directory = tempDir();
  const file = join(directory, "file");
  writeFileSync(file, "");
  const replacement = lstatSync(kind === "file" ? file : directory, { bigint: true });
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const mock = vi.mocked(lstatSync).mockImplementation((path, options) => {
    if (path === cwd && options?.bigint === true) return replacement;
    return actual.lstatSync(path, options);
  });
  try {
    expect(readTarget()).toBeUndefined();
  } finally {
    mock.mockRestore();
  }
  expect(readTarget()).toBeUndefined();
});
