/**
 * Releasing the lease never exposes it without its owner record (PRD §9.2, C-PERF-04).
 * A contender that polls between the release's filesystem steps must see a whole lease or
 * none, never an ownerless one it would recover as stale and follow with a duplicate update.
 */

import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { beforeEach, expect, test, vi } from "vitest";
import { coordinatedAutoupdate } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

const release = vi.hoisted(() => ({ held: false, renameDenied: false, deleteDenied: false }));
beforeEach(() => Object.assign(release, { held: false, renameDenied: false, deleteDenied: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const denied = () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
  // Hold the release open after its first step, long enough for a 1 ms poller to look. This
  // stays a duration rather than a barrier signalled by the contender's poll: a contender is
  // not obliged to poll — with an atomic release it can claim the freed path outright and
  // never stat again — so a barrier either hangs or has to be raced against a timeout that
  // closes the window early. Measured against a deliberately non-atomic release, the hold
  // below catches the duplicate 8/8 runs where a poll barrier caught it 5/8.
  const held = async <T>(step: Promise<T>): Promise<T> => {
    const result = await step;
    if (release.held) await delay(50);
    return result;
  };
  return {
    ...actual,
    // The first step of a two-step release, kept so this test pins the invariant against any
    // release protocol rather than only the atomic one below it.
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
  let updated = false;
  await expect(
    coordinatedAutoupdate(
      "codex",
      () => {
        updated = true;
        return Promise.resolve();
      },
      { root },
    ),
  ).resolves.toBeUndefined();
  // Resolving is not enough: the update itself must have run despite the failed release.
  expect(updated).toBe(true);
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

test("C-PERF-04 both kinds of leftover share one removal budget", async () => {
  const root = tempDir("elwood-update-lock-mixed-");
  // Six of each kind: a per-prefix budget of 8 would clear all twelve, the shared budget
  // clears exactly 8 and leaves 4 for the next holder. The mix also keeps the count
  // independent of which prefix `readdir` happens to yield first.
  for (let index = 0; index < 6; index += 1) {
    mkdirSync(join(root, `codex.lock.claim.${index}`));
    mkdirSync(join(root, `codex.lock.released.${index}`));
  }
  const leftovers = () =>
    readdirSync(root).filter((entry) => entry.includes(".claim.") || entry.includes(".released."))
      .length;
  await coordinatedAutoupdate("codex", () => Promise.resolve(), { root });
  expect(leftovers()).toBe(4);
  await coordinatedAutoupdate("codex", () => Promise.resolve(), { root });
  expect(leftovers()).toBe(0);
});
