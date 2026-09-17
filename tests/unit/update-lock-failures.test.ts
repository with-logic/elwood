/**
 * Filesystem-failure coverage for the global update lease.
 * Implements PRD §9.2 and C-LIFE-09's best-effort, stale-safe behavior.
 */

import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { coordinatedAutoupdate, updateLockPath } from "../../src/runtime/update/lock.ts";
import { tempDir } from "../helpers/tmp.ts";

const failures = vi.hoisted(() => ({
  ownerWrite: false,
  stagingRm: false,
  rootReaddir: false,
  recoveryRename: false,
  recoveryRmdir: false,
  staleUnlink: false,
  releaseUnlink: false,
  // A fake HOME under the OS temp dir (set by the `node:os` mock below, which is the
  // first place the real `tmpdir()` is reachable) so the default lease root is
  // exercised without touching the developer's real cache directory.
  mockHome: "",
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  failures.mockHome = `${actual.tmpdir()}/elwood-update-lock-default-${process.pid}`;
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: failures.mockHome }) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (...args: Parameters<typeof actual.rename>) => {
      const destination = String(args[1]);
      if (failures.recoveryRename && destination.endsWith(".recovery")) return denied();
      return actual.rename(...args);
    },
    rmdir: (...args: Parameters<typeof actual.rmdir>) => {
      const path = String(args[0]);
      if (failures.recoveryRmdir && path.endsWith(".recovery")) return denied();
      return actual.rmdir(...args);
    },
    rm: (...args: Parameters<typeof actual.rm>) =>
      failures.stagingRm && String(args[0]).includes(".claim.") ? denied() : actual.rm(...args),
    opendir: ((...args: Parameters<typeof actual.opendir>) =>
      failures.rootReaddir ? denied() : actual.opendir(...args)) as typeof actual.opendir,
    unlink: (...args: Parameters<typeof actual.unlink>) => {
      const path = String(args[0]);
      if ((failures.staleUnlink || failures.releaseUnlink) && path.endsWith("/owner"))
        return denied();
      return actual.unlink(...args);
    },
    writeFile: (...args: Parameters<typeof actual.writeFile>) => {
      const path = String(args[0]);
      if (failures.ownerWrite && path.endsWith("/owner")) {
        failures.ownerWrite = false;
        return denied();
      }
      return actual.writeFile(...args);
    },
  };
});

beforeEach(() => {
  failures.ownerWrite = false;
  failures.stagingRm = false;
  failures.rootReaddir = false;
  failures.recoveryRename = false;
  failures.recoveryRmdir = false;
  failures.staleUnlink = false;
  failures.releaseUnlink = false;
});

test("default lease options coordinate through the stable account cache", async () => {
  rmSync(failures.mockHome, { recursive: true, force: true });
  let ran = false;
  await coordinatedAutoupdate("codex", () => {
    ran = true;
    return Promise.resolve();
  });
  expect(ran).toBe(true);
  rmSync(failures.mockHome, { recursive: true, force: true });
});

test("an owner-record write failure skips this update and cannot block the next", async () => {
  const root = await sandbox("owner-write");
  const attempts: string[] = [];
  const update = (name: string) =>
    coordinatedAutoupdate("codex", async () => void attempts.push(name), options(root));
  // The claim fails before the lease exists, and cannot even remove its own staging.
  failures.ownerWrite = true;
  failures.stagingRm = true;
  await update("unwritable");
  expect(attempts).toEqual([]);
  // The orphaned staging is no lease: the next claim succeeds though its sweep fails too.
  await update("next");
  failures.stagingRm = false;
  await update("sweeping");
  expect(attempts).toEqual(["next", "sweeping"]);
  expect(readdirSync(root)).toEqual(["codex.completed"]);
});

test("an unreadable lease root cannot stop the lease holder from updating", async () => {
  const root = await sandbox("root-readdir");
  failures.rootReaddir = true;
  let ran = false;
  await coordinatedAutoupdate(
    "codex",
    () => {
      ran = true;
      return Promise.resolve();
    },
    options(root),
  );
  expect(ran).toBe(true);
});

test("a stale-owner unlink failure fails safe without a duplicate update", async () => {
  const root = await sandbox("stale-unlink");
  staleDeadLease(root);
  failures.staleUnlink = true;
  let ran = false;
  await coordinatedAutoupdate(
    "codex",
    () => {
      ran = true;
      return Promise.resolve();
    },
    options(root),
  );
  expect(ran).toBe(false);
});

test("a recovery-move permission failure fails safe", async () => {
  const root = await sandbox("recovery-rename");
  staleDeadLease(root);
  failures.recoveryRename = true;
  let ran = false;
  await coordinatedAutoupdate(
    "codex",
    () => {
      ran = true;
      return Promise.resolve();
    },
    options(root),
  );
  expect(ran).toBe(false);
});

test("recovery cleanup failure skips the updater safely", async () => {
  const root = await sandbox("recovery-rmdir");
  staleDeadLease(root);
  failures.recoveryRmdir = true;
  let ran = false;
  await coordinatedAutoupdate(
    "codex",
    () => {
      ran = true;
      return Promise.resolve();
    },
    options(root),
  );
  expect(ran).toBe(false);
});

test("an owner unlink failure cannot mask update success", async () => {
  const root = await sandbox("release-unlink");
  failures.releaseUnlink = true;
  await expect(
    coordinatedAutoupdate("codex", () => Promise.resolve(), options(root)),
  ).resolves.toBeUndefined();
});

const options = (root: string) => ({ root, pollMs: 1, staleMs: 1 });

function sandbox(label: string): string {
  return tempDir(`elwood-update-lock-${label}-`);
}

function staleDeadLease(root: string): void {
  const path = updateLockPath("codex", root);
  mkdirSync(path);
  writeFileSync(join(path, "owner"), "99999999:00000000-0000-4000-8000-000000000000");
  const stale = new Date(Date.now() - 1_000);
  utimesSync(path, stale, stale);
}

function denied(): Promise<never> {
  return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
}
