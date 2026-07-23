/**
 * Conformance tests: a FAILED Codex start never leaks its socket home, and the home is
 * restart-safe (one STABLE `/tmp/elwood-<fingerprint>` per session, not a leaked
 * anonymous dir per launch). Covers PRD §9.1/§8.1 (mirrors Claude): the socket binds in
 * the session's stable home before any state/runtime write, bridge start, or PTY start;
 * ANY pre-session failure removes it (withSocketHomeCleanup), and teardown sweeps it.
 * Each test isolates `TMPDIR` so the leak check sees only this launch's socket homes.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { setCodexHookBridgeFactoryForTests } from "../../src/codex/session.ts";
import { resumeCodex, startCodex } from "../../src/index.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { becomeReady, installFakes, resetFakes, tempDir } from "./helpers.ts";

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

  test("a REAL runtime file-write failure during resume removes the minted socket home", async () => {
    // Prove the ownership boundary end-to-end, not just the helper: induce an ACTUAL
    // runtime-file write failure inside `buildCodexSession` (writeCodexRuntimeFiles)
    // during a real resume, and assert the minted socket home is swept. If those writes
    // ever moved OUTSIDE `withSocketHomeCleanup`, this leak would resurface.
    const cwd = tempDir(); // created under the REAL tmp, before we isolate
    installFakes();
    const priv = isolateTmp();
    const first = await startCodex({ cwd });
    await becomeReady(first.elwoodSessionId, cwd); // SessionStart persists the codex resumeId
    await first.stop(); // stop keeps state (and the stable home) for resume
    expect(socketHomesIn(priv)).toHaveLength(1);
    // Plant a DIRECTORY where writeCodexRuntimeFiles will write the bridge script: the
    // atomic write's final rename onto a non-empty directory throws a real fs error
    // inside the build body — exactly a failed runtime write.
    const sessionDir = join(resolve(cwd, ".elwood"), "sessions", first.elwoodSessionId);
    const bridgeScript = join(sessionDir, "hook-bridge.mjs");
    rmSync(bridgeScript, { force: true });
    mkdirSync(join(bridgeScript, "block"), { recursive: true }); // non-empty dir at target
    await expect(resumeCodex({ elwoodSessionId: first.elwoodSessionId, cwd })).rejects.toThrow();
    // The boundary removed the socket home the failed resume minted, not left it behind.
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

  test("§8.1 start→stop→resume→teardown is restart-safe: ONE stable home, fully collected", async () => {
    // The Codex mirror of the Claude restart-safe regression: a session's home is STABLE
    // (fingerprint of the id), so a resume — even in a fresh process remembering no prior
    // path — reuses the SAME home, not a leaked new one. Teardown sweeps every launch.
    const cwd = tempDir();
    installFakes();
    const priv = isolateTmp();
    const first = await startCodex({ cwd });
    await becomeReady(first.elwoodSessionId, cwd);
    await first.stop(); // stop keeps state (and the home) for resume
    expect(socketHomesIn(priv)).toHaveLength(1);
    const resumed = await resumeCodex({ elwoodSessionId: first.elwoodSessionId, cwd });
    expect(socketHomesIn(priv)).toHaveLength(1); // reused the SAME stable home, not two
    await resumed.teardown();
    expect(socketHomesIn(priv)).toEqual([]); // the single home (all launches) collected
  });
});
