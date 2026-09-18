/**
 * Cross-process autoupdate lease coverage (PRD §9.2, C-LIFE-09/C-PERF-04).
 * Global agent installers mutate one shared binary, so separate Elwood hosts
 * must serialize them rather than relying only on a module-local promise.
 */

import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { coordinatedAutoupdate, updateLockPath } from "../../src/runtime/update/lock.ts";
import { tempDir } from "../helpers/tmp.ts";

const leaseOptions = (root: string) => ({ root, pollMs: 5, staleMs: 500 });

describe("cross-process autoupdate lease", () => {
  test("production defaults use a per-user cache root under HOME, independent of TMPDIR", () => {
    const sandbox = tempDir("elwood-update-lock-defaults-");
    const priorTmpdir = process.env["TMPDIR"];
    process.env["TMPDIR"] = sandbox;
    try {
      const user = userInfo();
      const path = updateLockPath("codex");
      expect(relative(user.homedir, path).startsWith("..")).toBe(false); // under HOME
      expect(path.startsWith(sandbox)).toBe(false); // never under TMPDIR
      expect(path).toContain(`${user.uid}-updates`); // scoped to the account
      expect(path.endsWith("codex.lock")).toBe(true); // named by adapter
    } finally {
      if (priorTmpdir === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = priorTmpdir;
    }
  });

  test("C-LIFE-09 in-process contenders also run one updater and release the lease", async () => {
    const root = tempDir("elwood-update-lock-unit-");
    const attempts: number[] = [];
    const run = () =>
      coordinatedAutoupdate(
        "codex",
        async () => {
          attempts.push(process.pid);
          await new Promise((resolve) => setTimeout(resolve, 40));
        },
        leaseOptions(root),
      );
    await Promise.all(Array.from({ length: 8 }, run));
    expect(attempts).toHaveLength(1);
    expect(existsSync(updateLockPath("codex", root))).toBe(false);
  });

  test("C-PERF-04 a stale owner lease is replaced by one fresh updater", async () => {
    const root = tempDir("elwood-update-lock-stale-");
    const path = updateLockPath("claude", root);
    mkdirSync(path);
    const stale = new Date(Date.now() - 1_000);
    utimesSync(path, stale, stale);
    let attempts = 0;
    await coordinatedAutoupdate(
      "claude",
      () => {
        attempts += 1;
        return Promise.resolve();
      },
      leaseOptions(root),
    );
    expect(attempts).toBe(1);
  });

  test("a stale lease recorded for a dead owner is recovered", async () => {
    const root = tempDir("elwood-update-lock-dead-");
    const path = updateLockPath("codex", root);
    mkdirSync(path);
    writeFileSync(join(path, "owner"), "99999999:00000000-0000-4000-8000-000000000000");
    const stale = new Date(Date.now() - 1_000);
    utimesSync(path, stale, stale);
    let ran = false;
    await coordinatedAutoupdate(
      "codex",
      () => {
        ran = true;
        return Promise.resolve();
      },
      leaseOptions(root),
    );
    expect(ran).toBe(true);
  });

  test("a cleaner killed after its atomic move cannot orphan the lease", async () => {
    const root = tempDir("elwood-update-lock-orphan-");
    const recovery = `${updateLockPath("codex", root)}.recovery`;
    mkdirSync(recovery);
    writeFileSync(join(recovery, "owner"), "99999999:00000000-0000-4000-8000-000000000000");
    const stale = new Date(Date.now() - 1_000);
    utimesSync(recovery, stale, stale);
    let ran = false;
    await coordinatedAutoupdate(
      "codex",
      () => {
        ran = true;
        return Promise.resolve();
      },
      leaseOptions(root),
    );
    expect(ran).toBe(true);
  });

  test("a failed owner update releases its lease for a later attempt", async () => {
    const root = tempDir("elwood-update-lock-failure-");
    await expect(
      coordinatedAutoupdate(
        "codex",
        () => Promise.reject(new Error("update failed")),
        leaseOptions(root),
      ),
    ).rejects.toThrow("update failed");
    let retried = false;
    await coordinatedAutoupdate(
      "codex",
      () => {
        retried = true;
        return Promise.resolve();
      },
      leaseOptions(root),
    );
    expect(retried).toBe(true);
  });

  // A cleanup failure no longer masking update success is covered where the failure can
  // actually be produced: `update-lock/release-window.test.ts` denies the retired
  // directory's deletion outright. Occupying the lease with an extra child used to fail
  // `rmdir`, but the retirement removes the directory recursively, so that fixture tested
  // the success path while claiming to test the failure one.

  test("an old owner never removes a successor generation", async () => {
    const root = tempDir("elwood-update-lock-generation-");
    const path = updateLockPath("codex", root);
    await coordinatedAutoupdate(
      "codex",
      () => {
        writeFileSync(join(path, "owner"), `${process.pid}:00000000-0000-4000-8000-000000000000`);
        return Promise.resolve();
      },
      leaseOptions(root),
    );
    expect(existsSync(path)).toBe(true);
  });

  test("a malformed stale lease fails safe without running a second updater", async () => {
    const root = tempDir("elwood-update-lock-malformed-");
    const path = updateLockPath("codex", root);
    mkdirSync(path);
    writeFileSync(join(path, "owner"), "not a valid owner");
    const stale = new Date(Date.now() - 1_000);
    utimesSync(path, stale, stale);
    let ran = false;
    await coordinatedAutoupdate(
      "codex",
      () => {
        ran = true;
        return Promise.resolve();
      },
      leaseOptions(root),
    );
    expect(ran).toBe(false);
  });
});
