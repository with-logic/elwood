/**
 * Conformance tests: a FAILED Codex start never leaks its per-launch socket home.
 * Covers PRD §9.1 (mirrors the Claude adapter): sessionRuntime mints a fresh
 * out-of-tree `/tmp/elwood-*` socket home before any state/runtime write, bridge
 * start, or PTY start; ANY pre-session failure must remove it (withSocketHomeCleanup).
 * Each test isolates `TMPDIR` so the leak check sees only this launch's socket homes.
 */

import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { setCodexHookBridgeFactoryForTests } from "../../src/codex/session.ts";
import { startCodex } from "../../src/index.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { withSocketHomeCleanup } from "../../src/runtime/startup-cleanup.ts";
import { installFakes, resetFakes, tempDir } from "./helpers.ts";

const realTmp = tmpdir();
let privateTmp: string | undefined;

afterEach(() => {
  resetFakes();
  process.env["TMPDIR"] = realTmp;
  if (privateTmp) rmSync(privateTmp, { recursive: true, force: true });
  privateTmp = undefined;
});

function isolateTmp(): string {
  privateTmp = mkdtempSync(join(realTmp, "elwood-sockhome-"));
  process.env["TMPDIR"] = privateTmp;
  return privateTmp;
}

function socketHomesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((entry) => entry.startsWith("elwood-"))
    .map((entry) => join(dir, entry))
    .filter((full) => statSync(full).isDirectory());
}

describe("§9.1 a failed Codex start does not leak the socket home", () => {
  test("a bridge-start failure removes the socket home AND shuts down the partial bridge", async () => {
    const cwd = tempDir(); // created under the REAL tmp, before we isolate
    installFakes();
    let stops = 0;
    setCodexHookBridgeFactoryForTests(() => ({
      start: () => Promise.reject(new Error("bridge failed")),
      // stop() ALSO rejects: the best-effort shutdown must be contained so the
      // ORIGINAL bridge-start error is the one that surfaces, not this secondary one.
      stop: () => {
        stops += 1;
        return Promise.reject(new Error("stop failed too"));
      },
    }));
    const priv = isolateTmp();
    await expect(startCodex({ cwd })).rejects.toMatchObject({
      code: "hook_bridge_failed", // NOT "stop failed too" — the secondary error is contained
    });
    expect(socketHomesIn(priv)).toEqual([]);
    expect(stops).toBe(1); // the partially-started bridge's listener is not leaked
  });

  test("a PTY-start failure removes the socket home", async () => {
    const cwd = tempDir();
    installFakes();
    setPtyFactoryForTests(() => {
      throw new Error("pty failed");
    });
    const priv = isolateTmp();
    await expect(startCodex({ cwd })).rejects.toMatchObject({
      code: "pty_start_failed",
    });
    expect(socketHomesIn(priv)).toEqual([]);
  });

  test("withSocketHomeCleanup removes the home on a file-write (build) failure", async () => {
    const priv = isolateTmp();
    const home = mkdtempSync(join(priv, "elwood-"));
    await expect(
      withSocketHomeCleanup(
        () => rmSync(home, { recursive: true, force: true }),
        () => Promise.reject(new Error("writeCodexRuntimeFiles failed: ENOSPC")),
      ),
    ).rejects.toThrow("ENOSPC");
    expect(socketHomesIn(priv)).toEqual([]);
  });

  test("on SUCCESS the socket home persists (ownership transfers to the session)", async () => {
    const cwd = tempDir();
    installFakes();
    const priv = isolateTmp();
    const session = await startCodex({ cwd });
    expect(socketHomesIn(priv)).toHaveLength(1);
    await session.teardown();
    expect(socketHomesIn(priv)).toEqual([]);
  });
});
