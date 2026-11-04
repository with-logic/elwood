/** Lease-claim outcomes after a contender’s staging directory disappears (C-PERF-04). */
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test, vi } from "vitest";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

const race = vi.hoisted(() => ({
  intercept: false,
  heldOwner: "",
  lease: "",
  failed: false,
  otherError: false,
  staged: (_path: string) => {},
  resume: () => Promise.resolve(),
  observed: () => {},
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const path = String(args[0]);
      if (race.intercept && path.includes(".claim.") && path.endsWith("/owner")) {
        race.intercept = false;
        race.heldOwner = path;
        race.staged(path);
        await race.resume();
      }
      try {
        if (path === race.heldOwner && race.otherError)
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        return await actual.writeFile(...args);
      } catch (error) {
        if (path === race.heldOwner) race.failed = true;
        throw error;
      }
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const result = await actual.stat(...args);
      if (race.failed && String(args[0]) === race.lease) race.observed();
      return result;
    },
  };
});

test.each([
  "lease",
  "recovery",
  "missing",
  "other-error",
] as const)("C-PERF-04 missing staging handles the %s claim outcome", async (state) => {
  const root = tempDir("elwood-swept-claim-");
  const staged = Promise.withResolvers<string>();
  const resume = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const observed = Promise.withResolvers<void>();
  const attempts: string[] = [];
  Object.assign(race, {
    intercept: true,
    heldOwner: "",
    lease: updateLockPath("codex", root),
    failed: false,
    otherError: state === "other-error",
    staged: staged.resolve,
    resume: () => resume.promise,
    observed: observed.resolve,
  });
  const options = { root, pollMs: 1, staleMs: 30_000 };
  const contender = coordinatedAutoupdate(
    "codex",
    () => Promise.resolve(void attempts.push("contender")),
    options,
  );
  let owner: Promise<unknown> | undefined;
  try {
    const staging = dirname(await staged.promise);
    if (state === "missing") rmSync(staging, { recursive: true });
    else {
      owner = coordinatedAutoupdate(
        "codex",
        async () => {
          attempts.push("owner");
          entered.resolve();
          await finish.promise;
        },
        options,
      );
      await entered.promise;
      expect(existsSync(staging)).toBe(false); // The real winning owner's sweep removed it.
      if (state === "recovery") renameSync(race.lease, `${race.lease}.recovery`);
    }
    resume.resolve();
    const first = await Promise.race([
      observed.promise.then(() => "observed"),
      contender.then(() => "returned"),
    ]);
    expect(first).toBe(state === "lease" || state === "recovery" ? "observed" : "returned");
    finish.resolve();
    await Promise.all([owner, contender]);
    expect(attempts).toEqual(state === "missing" ? [] : ["owner"]);
  } finally {
    resume.resolve();
    finish.resolve();
    race.intercept = false;
    await Promise.allSettled([owner, contender]);
  }
});
