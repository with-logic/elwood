/** Refusal evidence expires before a successor may mutate the installation (PRD §9.2). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

const race = vi.hoisted(() => ({
  ownerPath: "",
  completion: "",
  afterRead: undefined as undefined | (() => Promise<void>),
  denyCompletion: false,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const text = await actual.readFile(...args);
      if (String(args[0]) === race.ownerPath && race.afterRead) {
        const after = race.afterRead;
        race.afterRead = undefined;
        await after();
      }
      return text;
    },
    rename: (...args: Parameters<typeof actual.rename>) => {
      if (race.denyCompletion && String(args[1]) === race.completion)
        return Promise.reject(Object.assign(new Error("completion denied"), { code: "EACCES" }));
      return actual.rename(...args);
    },
  };
});

test.each([
  false,
  true,
])("C-LIFE-09 an A refusal cannot authorize C after B attempts with completion published=%s", async (published) => {
  const root = tempDir("elwood-refusal-generation-");
  const lease = updateLockPath("codex", root);
  const completion = join(root, "codex.completed");
  writeFileSync(completion, "historical");
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const attempts: string[] = [];
  const a = coordinatedAutoupdate(
    "codex",
    async () => {
      entered.resolve();
      await finish.promise;
      return { started: false };
    },
    { root },
  );
  await entered.promise;
  race.ownerPath = join(lease, "owner");
  race.completion = completion;
  race.afterRead = async () => {
    // C observes A, then misses B's entire real lease lifetime between reads.
    finish.resolve();
    expect(await a).toEqual({ started: false });
    expect(readFileSync(join(root, "codex.refused"), "utf8")).not.toBe("");
    race.denyCompletion = !published;
    await coordinatedAutoupdate("codex", () => Promise.resolve(void attempts.push("B")), { root });
  };
  try {
    await coordinatedAutoupdate("codex", () => Promise.resolve(void attempts.push("C")), { root });
    expect(attempts).toEqual(["B"]);
    const visible = readFileSync(completion, "utf8");
    expect(visible === "historical").toBe(!published);
    expect(existsSync(join(root, "codex.refused"))).toBe(false);
    expect(existsSync(lease)).toBe(false);
  } finally {
    race.afterRead = undefined;
    race.denyCompletion = false;
    finish.resolve();
    await a;
  }
});
