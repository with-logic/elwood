/**
 * Conformance tests: a FAILED Claude start never leaks its per-launch socket home.
 * Covers PRD §9.1: sessionRuntime mints a fresh out-of-tree `/tmp/elwood-*` socket
 * home BEFORE any state/runtime write, bridge start, or PTY start. ANY failure before
 * the session takes ownership must remove that directory (withSocketHomeCleanup); on
 * success ownership transfers to the session and teardown removes it.
 *
 * The socket home lands under `os.tmpdir()`, which honors `TMPDIR`. Each test points
 * `TMPDIR` at a FRESH private dir so the "was a socket home left behind?" check sees
 * ONLY this launch's homes — never a parallel worker's — making the assertion exact.
 */

import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { setHookBridgeFactoryForTests } from "../../src/claude/session.ts";
import { startClaude } from "../../src/index.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { withSocketHomeCleanup } from "../../src/runtime/startup-cleanup.ts";
import { installFakes, resetFakes, tempDir } from "./helpers.ts";

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

  test("withSocketHomeCleanup removes the home on a file-write (build) failure", async () => {
    // The state/runtime file writes run inside the wrapped build body, so a write
    // failure there is caught by the SAME boundary. Prove it directly: a build that
    // throws (as a failed writeSessionRecord/writeRuntimeFiles would) removes the home.
    const priv = isolateTmp();
    const home = mkdtempSync(join(priv, "elwood-")); // stand in for the minted home
    await expect(
      withSocketHomeCleanup(
        () => rmSync(home, { recursive: true, force: true }),
        () => Promise.reject(new Error("writeSessionRecord failed: ENOSPC")),
      ),
    ).rejects.toThrow("ENOSPC");
    expect(socketHomesIn(priv)).toEqual([]); // the home was removed by the boundary
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
});
