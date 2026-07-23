/**
 * Conformance tests: a FAILED Claude start never leaks its socket home, and the home
 * is restart-safe (one STABLE `/tmp/elwood-<fingerprint>` per session, not a leaked
 * anonymous dir per launch). Covers PRD §9.1/§8.1: sessionRuntime binds the socket in
 * the session's stable home BEFORE any state/runtime write, bridge start, or PTY start.
 * ANY failure before the session takes ownership removes it (withSocketHomeCleanup); on
 * success ownership transfers and teardown sweeps the whole home.
 *
 * The socket home lands under `os.tmpdir()`, which honors `TMPDIR`. Each test points
 * `TMPDIR` at a FRESH private dir so the "was a socket home left behind?" check sees
 * ONLY this launch's homes — never a parallel worker's — making the assertion exact.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { setHookBridgeFactoryForTests } from "../../src/claude/session.ts";
import { resumeClaude, startClaude } from "../../src/index.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const realTmp = tmpdir();
let privateTmp: string | undefined;

afterEach(() => {
  resetFakes();
  process.env["TMPDIR"] = realTmp; // restore before removing the private tmp
  if (privateTmp) rmSync(privateTmp, { recursive: true, force: true });
  privateTmp = undefined;
});

/** Point os.tmpdir() at a fresh private dir so socket homes are isolated per test. */
function isolateTmp(): string {
  privateTmp = mkdtempSync(join(realTmp, "elwood-sockhome-"));
  process.env["TMPDIR"] = privateTmp;
  return privateTmp;
}

/** `elwood-`-prefixed dirs under the private tmp — the socket-home shape. */
function socketHomesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((entry) => entry.startsWith("elwood-"))
    .map((entry) => join(dir, entry))
    .filter((full) => statSync(full).isDirectory());
}

describe("§9.1 a failed Claude start does not leak the socket home", () => {
  test("a bridge-start failure removes the socket home AND shuts down the partial bridge", async () => {
    const cwd = tempDir(); // created under the REAL tmp, before we isolate
    installFakes();
    let stops = 0;
    setHookBridgeFactoryForTests(() => ({
      start: () => Promise.reject(new Error("bridge failed")),
      // stop() ALSO rejects: the best-effort shutdown must be contained so the
      // ORIGINAL bridge-start error is the one that surfaces, not this secondary one.
      stop: () => {
        stops += 1;
        return Promise.reject(new Error("stop failed too"));
      },
    }));
    const priv = isolateTmp();
    await expect(startClaude({ cwd })).rejects.toMatchObject({
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
    await expect(startClaude({ cwd })).rejects.toMatchObject({
      code: "pty_start_failed",
    });
    expect(socketHomesIn(priv)).toEqual([]);
  });

  test("a REAL runtime file-write failure during resume removes the minted socket home", async () => {
    // Prove the ownership boundary end-to-end, not just the helper: induce an ACTUAL
    // runtime-file write failure inside `buildClaudeSession` (writeRuntimeFiles) during
    // a real resume, and assert the minted socket home is swept. If those writes ever
    // moved OUTSIDE `withSocketHomeCleanup`, this leak would resurface.
    const cwd = tempDir(); // created under the REAL tmp, before we isolate
    installFakes();
    const priv = isolateTmp();
    const first = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(first.elwoodSessionId, {
      hook_event_name: "SessionStart",
      session_id: "claude-resume-id",
      cwd,
      source: "startup",
    });
    await first.stop(); // stop keeps state (and the stable home) for resume
    expect(socketHomesIn(priv)).toHaveLength(1);
    // Plant a DIRECTORY where writeRuntimeFiles will try to write the bridge script:
    // the atomic write's final rename onto a non-empty directory throws a real fs error
    // inside the build body — exactly a failed runtime write.
    const sessionDir = join(resolve(cwd, ".elwood"), "sessions", first.elwoodSessionId);
    const bridgeScript = join(sessionDir, "hook-bridge.mjs");
    rmSync(bridgeScript, { force: true });
    mkdirSync(join(bridgeScript, "block"), { recursive: true }); // non-empty dir at target
    await expect(resumeClaude({ elwoodSessionId: first.elwoodSessionId, cwd })).rejects.toThrow();
    // The boundary removed the socket home the failed resume minted, not left it behind.
    expect(socketHomesIn(priv)).toEqual([]);
  });

  test("on SUCCESS the socket home persists (ownership transfers to the session)", async () => {
    const cwd = tempDir();
    installFakes();
    const priv = isolateTmp();
    const session = await startClaude({ cwd });
    expect(socketHomesIn(priv)).toHaveLength(1); // one live socket home owned by the session
    await session.teardown();
    expect(socketHomesIn(priv)).toEqual([]); // teardown removed it
  });

  test("§8.1 start→stop→resume→teardown is restart-safe: ONE stable home, fully collected", async () => {
    // A session's socket home is STABLE (fingerprint of the id), so a resume — even in a
    // fresh process that remembers no prior path — targets the SAME home rather than
    // leaking a new anonymous one per launch. stop() keeps it (for resume); teardown
    // sweeps every launch's socket by removing the one home.
    const cwd = tempDir();
    installFakes();
    const priv = isolateTmp();
    const first = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(first.elwoodSessionId, {
      hook_event_name: "SessionStart",
      session_id: "claude-restart",
      cwd,
      source: "startup",
    });
    await first.stop(); // stop keeps state (and the home) for resume
    expect(socketHomesIn(priv)).toHaveLength(1);
    const resumed = await resumeClaude({ elwoodSessionId: first.elwoodSessionId, cwd });
    // Resume reused the SAME stable home — still exactly one, not two leaked dirs.
    expect(socketHomesIn(priv)).toHaveLength(1);
    await resumed.teardown();
    expect(socketHomesIn(priv)).toEqual([]); // the single home (all launches) is gone
  });
});
