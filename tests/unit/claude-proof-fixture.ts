/** Typed, quota-free process boundaries and real private files for Claude proof tests (PRD §12). */
import type { SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import type { PtyFactory } from "../../src/pty/types.ts";
import type { runProbe } from "../../src/runtime/probe/index.ts";
import { resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { claudeQuestionVersion } from "../e2e/questions/claude-cases.ts";
import {
  nativeClaudeQuestionSandbox as createSandbox,
  claudeQuestionBinary as selectBinary,
} from "../e2e/questions/claude-sandbox.ts";
import { FakePty } from "../helpers/fake-pty.ts";
export function claudeQuestionBinary() {
  return selectBinary();
}
export function nativeClaudeQuestionSandbox() {
  return createSandbox();
}

type KeychainCommand = (...args: Parameters<typeof spawnSync>) => SpawnSyncReturns<string>;
const mocks = vi.hoisted(() => ({
  parent: "",
  keychain: vi.fn<KeychainCommand>(),
  probe: vi.fn<typeof runProbe>(),
  pty: vi.fn<PtyFactory>(),
  remove: vi.fn<typeof rmSync>(),
}));
export function claudeProofMocks() {
  return mocks;
}
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: mocks.keychain,
}));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => mocks.parent,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  mocks.remove.mockImplementation(fs.rmSync);
  return { ...fs, rmSync: mocks.remove };
});
vi.mock("../../src/runtime/probe/index.ts", async (original) => ({
  ...(await original<typeof import("../../src/runtime/probe/index.ts")>()),
  runProbe: mocks.probe,
}));
vi.mock("../../src/pty/node.ts", () => ({ nodePtyFactory: mocks.pty }));
beforeEach(() => {
  mocks.parent = mkdtempSync(join(tmpdir(), "elwood-claude-proof-parent-"));
  const versions = join(mocks.parent, ".local/share/claude/versions");
  mkdirSync(versions, { recursive: true });
  writeFileSync(join(versions, claudeQuestionVersion), "offline binary fixture");
  writeFileSync(join(mocks.parent, ".claude.json"), '{"parentOnly":true}');
  const credential: SpawnSyncReturns<string> = {
    pid: 1,
    output: [],
    status: 0,
    signal: null,
    stdout: '{"syntheticCredential":true}',
    stderr: "",
  };
  mocks.keychain.mockReset().mockReturnValue(credential);
  mocks.probe
    .mockReset()
    .mockResolvedValue({ status: 0, stdout: `${claudeQuestionVersion} (Claude Code)`, stderr: "" });
  mocks.pty.mockReset().mockImplementation((options) => new FakePty(options));
  mocks.remove.mockClear();
});
afterEach(() => {
  resetRuntimeSeamsForTests();
  rmSync(mocks.parent, { recursive: true, force: true });
});
