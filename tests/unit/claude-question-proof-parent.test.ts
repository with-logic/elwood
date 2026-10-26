/**
 * The native Claude question proof's parent checks (PRD §12, C-E2E-18): the parent settings,
 * hooks, and keychain login must not change, and the parent global config, which other Claude
 * sessions rewrite all the time, must never name the proof's private paths.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test, vi } from "vitest";
import { claudeProofMocks, nativeClaudeQuestionSandbox } from "./claude-proof-fixture.ts";

const mocks = claudeProofMocks();

/** Writes the parent's global config with `projects`. */
function parentProjects(projects: unknown): void {
  writeFileSync(join(mocks.parent, ".claude.json"), JSON.stringify({ parentOnly: true, projects }));
}

test("C-E2E-18 a concurrent session's rewrite of the parent global config is not drift", async () => {
  const sandbox = await nativeClaudeQuestionSandbox();
  writeFileSync(
    join(mocks.parent, ".claude.json"),
    JSON.stringify({ parentOnly: true, numStartups: 9, projects: { "/work/elsewhere": {} } }),
  );
  sandbox.dispose();
  expect(existsSync(sandbox.root)).toBe(false);
});

test("C-E2E-18 a parent project entry for a sibling of the private root is not drift", async () => {
  const sandbox = await nativeClaudeQuestionSandbox();
  parentProjects({ [`${sandbox.root}-archive`]: {}, [`${sandbox.root}x/project`]: {} });
  sandbox.dispose();
});

test.each([
  ["the private project", (root: string) => join(root, "project")],
  ["the private root", (root: string) => root],
  ["the root's unresolved temp path", (root: string) => join(tmpdir(), basename(root))],
])("C-E2E-18 a parent project entry naming %s fails the proof", async (_name, key) => {
  const sandbox = await nativeClaudeQuestionSandbox();
  const named = key(sandbox.root);
  parentProjects({ [named]: {}, "/work/elsewhere": {} });
  expect(() => sandbox.dispose()).toThrow(
    `Parent Claude global config names the private root: ${named}`,
  );
  expect(existsSync(sandbox.root)).toBe(false);
});

test.each([
  null,
  [],
  "text",
])("C-E2E-18 a parent projects value %j that cannot be checked fails the proof", async (projects) => {
  const sandbox = await nativeClaudeQuestionSandbox();
  parentProjects(projects);
  expect(() => sandbox.dispose()).toThrow(
    "Parent Claude configuration holds a projects value that is not an object",
  );
});

test.each([
  ".claude/settings.json",
  ".claude/hooks.json",
])("C-E2E-18 a change to the parent's %s fails the proof", async (name) => {
  const sandbox = await nativeClaudeQuestionSandbox();
  mkdirSync(join(mocks.parent, ".claude"), { recursive: true });
  writeFileSync(join(mocks.parent, name), "{}");
  expect(() => sandbox.dispose()).toThrow(`Parent Claude configuration changed: ${name}`);
});

test("C-E2E-18 a change to the parent's keychain login fails the proof", async () => {
  const sandbox = await nativeClaudeQuestionSandbox();
  mocks.keychain.mockReturnValue({
    pid: 1,
    output: [],
    status: 0,
    signal: null,
    stdout: '{"rotated":true}',
    stderr: "",
  });
  expect(() => sandbox.dispose()).toThrow("Parent Claude configuration changed: keychain");
});

test.each([
  ["ELWOOD_E2E_USER_CLAUDE_CONFIG_DIR", "/work/claude-config"],
  ["CLAUDE_CONFIG_DIR", "/work/claude-config"],
])("C-E2E-18 the proof refuses a user %s it does not check", async (key, value) => {
  if (key === "CLAUDE_CONFIG_DIR") vi.stubEnv("ELWOOD_E2E_USER_CLAUDE_CONFIG_DIR", undefined);
  vi.stubEnv(key, value);
  await expect(nativeClaudeQuestionSandbox()).rejects.toThrow(
    "The native Claude question proof needs the default Claude config dir",
  );
  expect(mocks.keychain).not.toHaveBeenCalled();
});
