/** Offline isolation, cancellation and cleanup proofs for native Claude questions (PRD §12). */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { claudeQuestionArtifacts } from "../e2e/questions/claude-artifacts.ts";
import { claudeQuestionVersion } from "../e2e/questions/claude-cases.ts";
import { claudeProofLifecycle } from "../e2e/questions/claude-lifecycle.ts";
import {
  claudeQuestionBinary,
  nativeClaudeQuestionSandbox,
} from "../e2e/questions/claude-sandbox.ts";

const mocks = vi.hoisted(() => ({ parent: "", keychain: vi.fn(), probe: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: mocks.keychain,
}));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => mocks.parent,
}));
vi.mock("../../src/runtime/probe.ts", () => ({ runProbe: mocks.probe }));
beforeEach(() => {
  mocks.parent = mkdtempSync(join(tmpdir(), "elwood-claude-proof-parent-"));
  const versions = join(mocks.parent, ".local/share/claude/versions");
  mkdirSync(versions, { recursive: true });
  writeFileSync(join(versions, claudeQuestionVersion), "offline binary fixture");
  writeFileSync(join(mocks.parent, ".claude.json"), '{"parentOnly":true}');
  mocks.keychain.mockReset().mockReturnValue({ status: 0, stdout: '{"syntheticCredential":true}' });
  mocks.probe
    .mockReset()
    .mockResolvedValue({ status: 0, stdout: `${claudeQuestionVersion} (Claude Code)`, stderr: "" });
});
afterEach(() => {
  resetRuntimeSeamsForTests();
  rmSync(mocks.parent, { recursive: true, force: true });
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

test("artifact write and even diagnostic failures remain best-effort", () => {
  const root = mkdtempSync(join(tmpdir(), "elwood-claude-artifact-proof-"));
  const diagnostic = vi.fn();
  const artifacts = claudeQuestionArtifacts(() => undefined, root, diagnostic);
  rmSync(root, { recursive: true, force: true });
  expect(() => artifacts.save()).not.toThrow();
  expect(diagnostic).toHaveBeenCalledOnce();
  expect(() =>
    claudeQuestionArtifacts(
      () => undefined,
      root,
      () => {
        throw new Error("diagnostic");
      },
    ),
  ).not.toThrow();
});

test("cancellation during setup prevents lazy start but still disposes", async () => {
  const abort = new AbortController();
  const lifecycle = claudeProofLifecycle(abort.signal);
  abort.abort();
  const start = vi.fn(async () => undefined);
  await expect(lifecycle.start({ start, close: async () => undefined })).rejects.toThrow();
  expect(start).not.toHaveBeenCalled();
  const dispose = vi.fn();
  await lifecycle.finish([dispose], true, vi.fn());
  expect(dispose).toHaveBeenCalledOnce();
});

test("cancellation joins in-flight lazy start and never returns a turn-ready session", async () => {
  const abort = new AbortController();
  const lifecycle = claudeProofLifecycle(abort.signal);
  const started = Promise.withResolvers<void>();
  const close = vi.fn(async () => {
    await started.promise;
  });
  const pending = lifecycle.start({ start: () => started.promise, close });
  abort.abort();
  expect(close).toHaveBeenCalledOnce();
  started.resolve();
  await expect(pending).rejects.toThrow();
  const dispose = vi.fn();
  await lifecycle.finish([dispose], true, vi.fn());
  expect(close).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();
});

test.each([
  false,
  true,
])("cleanup attempts every action and preserves primary failure=%s", async (failed) => {
  const lifecycle = claudeProofLifecycle(new AbortController().signal);
  const failure = new Error("close");
  await lifecycle.start({
    start: async () => undefined,
    close: () => Promise.reject(failure),
  });
  const dispose = vi.fn();
  const diagnostic = vi.fn();
  const finish = lifecycle.finish(
    [
      () => {
        throw new Error("privacy");
      },
      dispose,
    ],
    failed,
    diagnostic,
  );
  if (failed) await expect(finish).resolves.toBeUndefined();
  else await expect(finish).rejects.toMatchObject({ errors: [failure, new Error("privacy")] });
  expect(dispose).toHaveBeenCalledOnce();
  expect(diagnostic).toHaveBeenCalledTimes(failed ? 1 : 0);
  if (failed) expect(diagnostic).toHaveBeenCalledWith("Claude question proof cleanup also failed");
});
