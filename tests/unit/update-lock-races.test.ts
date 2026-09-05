/**
 * Deterministic race-window coverage for the global update lease.
 * Implements PRD §9.2 and C-LIFE-09/C-PERF-04 generation safety.
 */

import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { coordinatedAutoupdate, updateLockPath } from "../../src/runtime/update-lock.ts";

const races = vi.hoisted(() => ({
  claimUntilRelease: false,
  claimDelayStarted: false,
  contendedRename: false,
  createRecoveryAfterOwner: false,
  mutateMovedOwner: false,
  ownerReleased: false,
  pretendRecoveryExists: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: (...args: Parameters<typeof actual.mkdir>) => {
      const path = String(args[0]);
      if (races.claimUntilRelease && path.endsWith(".lock")) {
        races.claimUntilRelease = false;
        races.claimDelayStarted = true;
        return waitForOwnerRelease().then(() => actual.mkdir(...args));
      }
      return actual.mkdir(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const destination = String(args[1]);
      if (races.contendedRename && destination.endsWith(".recovery")) {
        races.contendedRename = false;
        races.pretendRecoveryExists = true;
        throw Object.assign(new Error("contended"), { code: "EEXIST" });
      }
      const result = await actual.rename(...args);
      if (races.mutateMovedOwner && destination.endsWith(".recovery")) {
        races.mutateMovedOwner = false;
        await actual.writeFile(
          join(destination, "owner"),
          "99999998:11111111-1111-4111-8111-111111111111",
        );
      }
      return result;
    },
    rmdir: async (...args: Parameters<typeof actual.rmdir>) => {
      const result = await actual.rmdir(...args);
      if (String(args[0]).endsWith(".lock")) races.ownerReleased = true;
      return result;
    },
    stat: (...args: Parameters<typeof actual.stat>) => {
      const path = String(args[0]);
      if (races.pretendRecoveryExists && path.endsWith(".recovery")) {
        races.pretendRecoveryExists = false;
        return actual.stat(path.slice(0, -".recovery".length));
      }
      return actual.stat(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const result = await actual.writeFile(...args);
      const path = String(args[0]);
      if (races.createRecoveryAfterOwner && path.endsWith("/owner")) {
        races.createRecoveryAfterOwner = false;
        await actual.mkdir(`${path.slice(0, -"/owner".length)}.recovery`);
      }
      return result;
    },
  };
});

beforeEach(() => {
  races.claimUntilRelease = false;
  races.claimDelayStarted = false;
  races.contendedRename = false;
  races.createRecoveryAfterOwner = false;
  races.mutateMovedOwner = false;
  races.ownerReleased = false;
  races.pretendRecoveryExists = false;
});

test("a delayed claimant observes a peer completion and skips its duplicate", async () => {
  const root = await sandbox("completion");
  const attempts: string[] = [];
  races.claimUntilRelease = true;
  const delayed = run(root, () => attempts.push("delayed"));
  while (!races.claimDelayStarted) await new Promise((resolve) => setImmediate(resolve));
  const winner = run(root, () => attempts.push("winner"));
  await Promise.all([delayed, winner]);
  expect(attempts).toEqual(["winner"]);
});

test("a recovery marker appearing after claim prevents the updater from starting", async () => {
  const root = await sandbox("post-claim-recovery");
  races.createRecoveryAfterOwner = true;
  let attempts = 0;
  await run(root, () => {
    attempts += 1;
  });
  expect(attempts).toBe(1);
});

test("a generation changed during stale recovery fails safe", async () => {
  const root = await sandbox("moved-generation");
  staleDeadLease(root);
  races.mutateMovedOwner = true;
  let ran = false;
  await run(root, () => {
    ran = true;
  });
  expect(ran).toBe(false);
});

test("contended stale recovery waits for the active cleaner", async () => {
  const root = await sandbox("contended-recovery");
  staleDeadLease(root);
  races.contendedRename = true;
  let ran = false;
  await run(root, () => {
    ran = true;
  });
  expect(ran).toBe(true);
});

function run(root: string, update: () => void): Promise<void> {
  return coordinatedAutoupdate(
    "codex",
    () => {
      update();
      return Promise.resolve();
    },
    { root, pollMs: 1, staleMs: 1 },
  );
}

async function waitForOwnerRelease(): Promise<void> {
  while (!races.ownerReleased) await new Promise((resolve) => setImmediate(resolve));
}

function sandbox(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `elwood-update-lock-${label}-`));
}

function staleDeadLease(root: string): void {
  const path = updateLockPath("codex", root);
  mkdirSync(path);
  writeFileSync(join(path, "owner"), "99999999:00000000-0000-4000-8000-000000000000");
  const stale = new Date(Date.now() - 1_000);
  utimesSync(path, stale, stale);
}
