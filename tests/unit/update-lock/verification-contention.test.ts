/** A contender retries a lease generation that never invoked an updater (PRD §9.2, C-LIFE-09). */
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { coordinatedAutoupdate } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

const observation = vi.hoisted(() => ({
  notify: () => {},
  denyPublication: false,
  holdNextOwnerRead: false,
  ownerSettled: () => Promise.resolve(),
}));
beforeEach(() =>
  Object.assign(observation, {
    notify: () => {},
    denyPublication: false,
    holdNextOwnerRead: false,
    ownerSettled: () => Promise.resolve(),
  }),
);
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (...args: Parameters<typeof actual.rename>) => {
      if (observation.denyPublication && String(args[1]).endsWith("/codex.completed"))
        return Promise.reject(Object.assign(new Error("publication refused"), { code: "EACCES" }));
      return actual.rename(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...args);
      if (observation.holdNextOwnerRead && String(args[0]).endsWith("/codex.lock/owner")) {
        // Hold the waiter's captured identity, without holding the owner's release read.
        observation.holdNextOwnerRead = false;
        observation.notify();
        await observation.ownerSettled();
      }
      return result;
    },
  };
});

test.each([
  "refused",
  "completion-unwritable",
  "refusal-unwritable",
  "refusal-malformed",
])("C-LIFE-09 an observed %s owner retries only with a conclusive refusal receipt", async (scenario) => {
  const root = tempDir("elwood-update-verification-contention-");
  observation.denyPublication = scenario === "completion-unwritable";
  const entered = Promise.withResolvers<void>();
  const observed = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const owner = coordinatedAutoupdate(
    "codex",
    async () => {
      // Structural failures remain unwritable even when these tests run as root.
      if (scenario === "refusal-malformed")
        symlinkSync("codex.refused", join(root, "codex.refused"));
      else if (scenario === "refusal-unwritable") mkdirSync(join(root, "codex.refused"));
      entered.resolve();
      await finish.promise;
      return scenario === "completion-unwritable" ? undefined : { started: false };
    },
    { root, pollMs: 1, waitMs: 1_000 },
  );
  let contender: ReturnType<typeof coordinatedAutoupdate> | undefined;
  let updates = 0;
  try {
    await Promise.race([
      entered.promise,
      owner.then(() => {
        throw new Error("Owner settled before entering its callback.");
      }),
    ]);
    observation.notify = observed.resolve;
    observation.holdNextOwnerRead = true;
    observation.ownerSettled = async () => {
      await owner;
    };
    contender = coordinatedAutoupdate(
      "codex",
      () => {
        updates += 1;
        return Promise.resolve();
      },
      { root, pollMs: 1, waitMs: 1_000 },
    );
    await Promise.race([
      observed.promise,
      contender.then(() => {
        throw new Error("Contender settled before observing its owner.");
      }),
    ]);
    finish.resolve();
    expect(await owner).toEqual(
      scenario === "completion-unwritable" ? undefined : { started: false },
    );
    const outcome = await contender.catch((error: unknown) => error);
    if (scenario === "refused") expect(outcome).toBeUndefined();
    else
      expect(outcome).toMatchObject({
        code: "codex_update_failed",
        details: { updateOutcome: "unconfirmed" },
      });
    expect(updates).toBe(scenario === "refused" ? 1 : 0);
    if (updates === 1) expect(readFileSync(join(root, "codex.completed"), "utf8")).not.toBe("");
  } finally {
    finish.resolve();
    await Promise.allSettled([owner, contender]);
  }
});
