/**
 * Releasing the lease never exposes it without its owner record (PRD §9.2, C-PERF-04).
 * A contender that polls between the release's filesystem steps must see a whole lease or
 * none, never an ownerless one it would recover as stale and follow with a duplicate update.
 */

import { readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { beforeEach, expect, test, vi } from "vitest";
import { coordinatedAutoupdate } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

const release = vi.hoisted(() => ({ held: false, renameDenied: false, deleteDenied: false }));
beforeEach(() => Object.assign(release, { held: false, renameDenied: false, deleteDenied: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const denied = () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
  // Hold the release open after its first step, long enough for a 1 ms poller to look.
  const held = async <T>(step: Promise<T>): Promise<T> => {
    const result = await step;
    if (release.held) await delay(50);
    return result;
  };
  return {
    ...actual,
    unlink: (...args: Parameters<typeof actual.unlink>) =>
      String(args[0]).endsWith(".lock/owner")
        ? held(actual.unlink(...args))
        : actual.unlink(...args),
    rename: (...args: Parameters<typeof actual.rename>) => {
      if (!String(args[1]).includes(".lock.released.")) return actual.rename(...args);
      return release.renameDenied ? denied() : held(actual.rename(...args));
    },
    rm: (...args: Parameters<typeof actual.rm>) =>
      release.deleteDenied && String(args[0]).includes(".released.")
        ? denied()
        : actual.rm(...args),
  };
});

test("C-PERF-04 a contender polling during the owner's release never runs a duplicate update", async () => {
  const root = tempDir("elwood-update-lock-release-");
  release.held = true;
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const attempts: string[] = [];
  const owner = coordinatedAutoupdate(
    "codex",
    async () => {
      attempts.push("owner");
      entered.resolve();
      await finish.promise;
    },
    { root },
  );
  await entered.promise;
  // Every lease is stale to this contender the moment it is not provably live.
  const contender = coordinatedAutoupdate("codex", async () => void attempts.push("contender"), {
    root,
    pollMs: 1,
    staleMs: 0,
  });
  await delay(20);
  finish.resolve();
  await Promise.all([owner, contender]);
  expect(attempts).toEqual(["owner"]);
});

test("a release failure cannot mask update success", async () => {
  const root = tempDir("elwood-update-lock-release-denied-");
  release.renameDenied = true;
  await expect(
    coordinatedAutoupdate("codex", () => Promise.resolve(), { root }),
  ).resolves.toBeUndefined();
});

test("a retired lease that cannot be deleted is swept by a later holder", async () => {
  const root = tempDir("elwood-update-lock-retired-");
  release.deleteDenied = true;
  await coordinatedAutoupdate("codex", () => Promise.resolve(), { root });
  // The lease itself is gone; only its retired directory is left behind.
  expect(readdirSync(root).filter((entry) => entry.includes(".released."))).toHaveLength(1);
  release.deleteDenied = false;
  await coordinatedAutoupdate("codex", () => Promise.resolve(), { root });
  expect(readdirSync(root)).toEqual(["codex.completed"]);
});
