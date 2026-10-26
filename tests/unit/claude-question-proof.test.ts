/** Offline private-home, bounded subprocess and process-seam guards (PRD §12). */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import {
  currentCommandRunner,
  currentPtyFactory,
  setCommandRunnerForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import { claudeQuestionVersion } from "../e2e/questions/claude-cases.ts";
import {
  claudeProofMocks,
  claudeQuestionBinary,
  nativeClaudeQuestionSandbox,
} from "./claude-proof-fixture.ts";

const mocks = claudeProofMocks();

test("malformed Keychain output never appears in parse errors", async () => {
  const canary = "SYNTHETIC_PRIVATE_KEYCHAIN_PARSE_CANARY";
  mocks.keychain.mockReturnValueOnce({
    pid: 1,
    status: 0,
    signal: null,
    output: [],
    stdout: canary,
    stderr: "",
  });
  const failure: unknown = await nativeClaudeQuestionSandbox().catch((error: unknown) => error);
  expect(failure instanceof Error).toBe(true);
  if (!(failure instanceof Error)) throw new Error("Expected sanitized authentication error");
  expect(failure.message).toBe("Private Claude authentication is malformed");
  expect(String(failure).includes(canary)).toBe(false);
  expect("cause" in failure).toBe(false);
});

test("a Keychain item without a Claude login stops setup before any private file", async () => {
  mocks.keychain.mockReturnValueOnce({
    pid: 1,
    status: 0,
    signal: null,
    output: [],
    stdout: '{"mcpOAuth":{}}',
    stderr: "",
  });
  await expect(nativeClaudeQuestionSandbox()).rejects.toThrow(
    "Private Claude authentication holds no Claude login",
  );
});

test.each([
  { status: 1, stdout: `${claudeQuestionVersion} (Claude Code)` },
  { status: null, stdout: `${claudeQuestionVersion} (Claude Code)` },
  { status: 0, stdout: "wrong version" },
])("failed version $status/$stdout cleans credentials and resets seams", async ({
  status,
  stdout,
}) => {
  const factory = currentPtyFactory();
  const runner = currentCommandRunner();
  setPtyFactoryForTests(() => {
    throw new Error("obsolete seam");
  });
  setCommandRunnerForTests(() => {
    throw new Error("obsolete seam");
  });
  mocks.probe.mockImplementationOnce((_command, args) => {
    const home = args[0]!.slice("HOME=".length);
    expect(existsSync(join(home, ".credentials.json"))).toBe(true);
    return Promise.resolve({ status, stdout, stderr: "" });
  });
  const setup = nativeClaudeQuestionSandbox();
  try {
    await expect(setup).rejects.toThrow("version unavailable");
  } finally {
    (await setup.catch(() => undefined))?.dispose();
  }
  const home = mocks.probe.mock.calls[0]![1][0]!.slice("HOME=".length);
  expect(existsSync(dirname(home))).toBe(false);
  expect(currentPtyFactory()).toBe(factory);
  expect(currentCommandRunner()).toBe(runner);
});

test("failed setup cleanup retains the original setup error", async () => {
  const primary = new Error("synthetic setup failure");
  mocks.probe.mockRejectedValueOnce(primary);
  mocks.remove.mockImplementationOnce(() => {
    throw new Error("synthetic cleanup failure");
  });
  try {
    await expect(nativeClaudeQuestionSandbox()).rejects.toBe(primary);
  } finally {
    const home = mocks.probe.mock.calls[0]![1][0]!.slice("HOME=".length);
    rmSync(dirname(home), { recursive: true, force: true });
  }
});

test("pinned-only setup reuses one credential and writes minimal config", async () => {
  expect(claudeQuestionBinary()).toBe(
    join(mocks.parent, ".local/share/claude/versions", claudeQuestionVersion),
  );
  const sandbox = await nativeClaudeQuestionSandbox();
  try {
    expect(mocks.keychain).toHaveBeenCalledTimes(1);
    const config: unknown = JSON.parse(readFileSync(join(sandbox.home, ".claude.json"), "utf8"));
    expect(config).toMatchObject({ lastOnboardingVersion: claudeQuestionVersion });
    expect(config).not.toHaveProperty("parentOnly");
    // The copy cannot refresh, so it never rotates the parent's login (C-E2E-23).
    const login: unknown = JSON.parse(
      readFileSync(join(sandbox.home, ".credentials.json"), "utf8"),
    );
    expect(login).toEqual({ claudeAiOauth: { accessToken: "synthetic" } });
  } finally {
    sandbox.dispose();
  }
  expect(mocks.keychain).toHaveBeenCalledTimes(2);
  expect(existsSync(sandbox.root)).toBe(false);
});

test.each([
  null,
  [],
  "text",
  1,
])("rejects non-record parent config %j before setup", async (value) => {
  writeFileSync(join(mocks.parent, ".claude.json"), JSON.stringify(value));
  const setup = nativeClaudeQuestionSandbox();
  try {
    await expect(setup).rejects.toThrow("must be a JSON object");
  } finally {
    (await setup.catch(() => undefined))?.dispose();
  }
  expect(mocks.probe).not.toHaveBeenCalled();
});

test("post-run non-record config reports the guard after removing private credentials", async () => {
  const sandbox = await nativeClaudeQuestionSandbox();
  writeFileSync(join(mocks.parent, ".claude.json"), "null");
  expect(() => sandbox.dispose()).toThrow("must be a JSON object");
  expect(existsSync(sandbox.root)).toBe(false);
});
