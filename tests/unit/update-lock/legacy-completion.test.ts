/** Completion evidence must affirm an attempt without changing legacy raw UUIDs (PRD §9.2). */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

const generation = "00000000-0000-4000-8000-00000000000a";
const historical = "00000000-0000-4000-8000-00000000000b";
const prefix = "elwood-update-attempt-v1:";
const race = vi.hoisted(() => ({
  ownerPath: "",
  afterRead: undefined as undefined | (() => void),
  publications: [] as string[],
}));
beforeEach(() => {
  race.afterRead = undefined;
  race.publications = [];
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...args);
      if (String(args[0]) === race.ownerPath && race.afterRead) {
        const after = race.afterRead;
        race.afterRead = undefined;
        after();
      }
      return result;
    },
    rename: (...args: Parameters<typeof actual.rename>) => {
      if (/codex\.completed(?:\.attempted)?$/.test(String(args[1])))
        race.publications.push(String(args[1]));
      return actual.rename(...args);
    },
  };
});

for (const position of ["already-visible", "changed-after-snapshot"] as const) {
  test.each([
    "legacy",
    "mismatch",
    "matching",
  ] as const)(`C-PERF-04 ${position} %s completion confirms only an affirmative pair`, async (evidence) => {
    const root = tempDir("elwood-legacy-completion-");
    const lease = updateLockPath("codex", root);
    const raw = join(root, "codex.completed");
    const attempted = `${raw}.attempted`;
    mkdirSync(lease);
    writeFileSync(join(lease, "owner"), `${process.pid}:${generation}`);
    writeFileSync(raw, position === "already-visible" ? generation : historical);
    if (position === "already-visible" && evidence !== "legacy")
      writeFileSync(attempted, prefix + (evidence === "matching" ? generation : historical));
    race.ownerPath = join(lease, "owner");
    race.afterRead = () => {
      if (position === "changed-after-snapshot") {
        if (evidence !== "legacy") {
          writeFileSync(
            `${attempted}.stage`,
            prefix + (evidence === "matching" ? generation : historical),
          );
          renameSync(`${attempted}.stage`, attempted);
        }
        // Legacy and new peers atomically replace the raw marker; never mutate its pinned inode.
        writeFileSync(`${raw}.stage`, generation);
        renameSync(`${raw}.stage`, raw);
      }
      rmSync(lease, { recursive: true });
    };
    let updates = 0;
    try {
      const result = coordinatedAutoupdate("codex", () => Promise.resolve(void updates++), {
        root,
        pollMs: 1,
        waitMs: 1_000,
      });
      if (evidence === "matching") await expect(result).resolves.toBeUndefined();
      else
        await expect(result).rejects.toMatchObject({
          code: "codex_update_failed",
          details: { updateOutcome: "unconfirmed" },
        });
      expect(updates).toBe(0);
      // Old readers continue to compare exactly the raw generation UUID.
      expect(readFileSync(raw, "utf8")).toBe(generation);
      expect(existsSync(attempted)).toBe(evidence !== "legacy");
    } finally {
      race.afterRead = undefined;
    }
  });
}

test("C-PERF-04 historical legacy evidence without an observed owner allows a new attempt", async () => {
  const root = tempDir("elwood-historical-completion-");
  const raw = join(root, "codex.completed");
  const attempted = `${raw}.attempted`;
  writeFileSync(raw, historical);
  let updates = 0;
  await coordinatedAutoupdate("codex", () => Promise.resolve(void updates++), { root });
  expect(updates).toBe(1);
  const current = readFileSync(raw, "utf8");
  expect(current).toMatch(/^[0-9a-f-]{36}$/);
  expect(current).not.toBe(historical);
  expect(readFileSync(attempted, "utf8")).toBe(prefix + current);
  expect(race.publications).toEqual([attempted, raw]);
});
