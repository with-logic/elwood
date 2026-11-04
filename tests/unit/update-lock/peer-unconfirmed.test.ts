/** Failed refusal publication stays unconfirmed for peers and never authorizes a retry (PRD §9.2). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { preflightCodex } from "../../../src/codex/preflight.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../../src/runtime/seams.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../../src/runtime/update/once.ts";
import { tempDir } from "../../helpers/tmp.ts";

const race = vi.hoisted(() => ({
  ownerPath: "",
  hold: false,
  observed: () => {},
  ownerSettled: () => Promise.resolve(),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...args);
      if (race.hold && String(args[0]) === race.ownerPath) {
        race.hold = false;
        race.observed();
        await race.ownerSettled();
      }
      return result;
    },
  };
});

test("C-LIFE-09 failed refusal receipt publication yields a bounded peer warning without a duplicate update", async () => {
  const root = tempDir("elwood-peer-unconfirmed-");
  const completion = join(root, "codex.completed");
  writeFileSync(completion, "historical");
  const ready = Promise.withResolvers<void>();
  const observed = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const owner = coordinatedAutoupdate(
    "codex",
    async () => {
      mkdirSync(join(root, "codex.refused")); // Structural write failure, including under root.
      ready.resolve();
      await finish.promise;
      return { started: false };
    },
    { root, waitMs: 1_000 },
  );
  void owner.catch(() => {});
  let waiter: ReturnType<typeof preflightCodex> | undefined;
  let updates = 0;
  let coordinationCalls = 0;
  resetAutoupdateForTests();
  resetPreflightCacheForTests();
  setPlatformForTests("darwin");
  setCommandRunnerForTests((_command, args) => {
    if (args.join(" ").includes("codex update")) updates++;
    return { status: 0, stdout: "codex-cli 0.150.0", stderr: "" };
  });
  setUpdateCoordinatorForTests((adapter, update) => {
    coordinationCalls++;
    return coordinatedAutoupdate(adapter, update, { root, pollMs: 1, waitMs: 1_000 });
  });
  try {
    await Promise.race([
      ready.promise,
      owner.then(() => {
        throw new Error("Owner settled before callback.");
      }),
    ]);
    Object.assign(race, {
      ownerPath: join(updateLockPath("codex", root), "owner"),
      hold: true,
      observed: observed.resolve,
      ownerSettled: async () => {
        await Promise.allSettled([owner]);
      },
    });
    waiter = preflightCodex(false, true);
    await Promise.race([
      observed.promise,
      waiter.then(() => {
        throw new Error("Waiter settled before observation.");
      }),
    ]);
    finish.resolve();
    const warning = await waiter;
    expect(warning).toMatchObject({
      code: "agent_update_failed",
      errorCode: "update_unconfirmed",
      raw: "",
    });
    expect(warning).not.toHaveProperty("exitStatus");
    expect(warning?.message).not.toContain(root);
    expect(await preflightCodex(false, true)).toEqual(warning);
    expect(coordinationCalls).toBe(1);
    expect(updates).toBe(0);
    expect(readFileSync(completion, "utf8")).toBe("historical");
    expect(existsSync(updateLockPath("codex", root))).toBe(false);
  } finally {
    finish.resolve();
    race.hold = false;
    await Promise.allSettled([owner, waiter]);
  }
});
