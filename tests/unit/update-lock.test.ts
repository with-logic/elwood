/**
 * Cross-process autoupdate lease coverage (PRD §9.2, C-LIFE-09/C-PERF-04).
 * Global agent installers mutate one shared binary, so separate Elwood hosts
 * must serialize them rather than relying only on a module-local promise.
 */

import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { coordinatedAutoupdate, updateLockPath } from "../../src/runtime/update-lock.ts";

const leaseOptions = (root: string) => ({ root, pollMs: 5, staleMs: 500 });

describe("cross-process autoupdate lease", () => {
  test("production defaults use an environment-independent per-user cache root", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "elwood-update-lock-defaults-"));
    const priorTmpdir = process.env["TMPDIR"];
    process.env["TMPDIR"] = sandbox;
    try {
      const user = userInfo();
      const expected = join(
        user.homedir,
        "Library",
        "Caches",
        "elwood",
        `${user.uid}-updates`,
        "codex.lock",
      );
      expect(updateLockPath("codex")).toBe(expected);
    } finally {
      if (priorTmpdir === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = priorTmpdir;
    }
  });

  test("a live owner is never evicted solely because staleMs elapsed", async () => {
    const root = await mkdtemp(join(tmpdir(), "elwood-update-lock-live-"));
    let active = 0;
    let maxActive = 0;
    let attempts = 0;
    const run = () =>
      coordinatedAutoupdate(
        "codex",
        async () => {
          attempts += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 40));
          active -= 1;
        },
        { root, pollMs: 2, staleMs: 5 },
      );
    await Promise.all(Array.from({ length: 4 }, run));
    expect({ attempts, maxActive }).toEqual({ attempts: 1, maxActive: 1 });
  });

  test("C-LIFE-09 in-process contenders also run one updater and release the lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "elwood-update-lock-unit-"));
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
    const root = await mkdtemp(join(tmpdir(), "elwood-update-lock-stale-"));
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
    const root = await mkdtemp(join(tmpdir(), "elwood-update-lock-dead-"));
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
    const root = await mkdtemp(join(tmpdir(), "elwood-update-lock-orphan-"));
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
    const root = await mkdtemp(join(tmpdir(), "elwood-update-lock-failure-"));
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

  test("an owner cleanup failure does not mask update success", async () => {
    const root = await mkdtemp(join(tmpdir(), "elwood-update-lock-cleanup-"));
    await expect(
      coordinatedAutoupdate(
        "codex",
        () => {
          writeFileSync(join(updateLockPath("codex", root), "unexpected"), "occupied");
          return Promise.resolve();
        },
        leaseOptions(root),
      ),
    ).resolves.toBeUndefined();
  });

  test("an old owner never removes a successor generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "elwood-update-lock-generation-"));
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
    const root = await mkdtemp(join(tmpdir(), "elwood-update-lock-malformed-"));
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
