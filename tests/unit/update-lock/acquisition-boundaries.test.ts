/** Recovery retains completion identity; marker read failures never imply incompletion (C-PERF-04). */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  marker: "",
  afterRead: undefined as undefined | (() => void),
  ownerPath: "",
  afterMissingOwner: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const text = await actual.readFile(...args).catch(async (error: unknown) => {
        if (String(args[0]) === race.ownerPath && race.afterMissingOwner) {
          const after = race.afterMissingOwner;
          race.afterMissingOwner = undefined;
          await after();
        }
        throw error;
      });
      if (String(args[0]) === race.marker && race.afterRead) {
        const after = race.afterRead;
        race.afterRead = undefined;
        after();
      }
      return text;
    },
  };
});

test.each([
  true,
  false,
])("C-PERF-04 a recovered owner already moved aside has completed=%s", async (completed) => {
  const root = tempDir("elwood-existing-recovery-");
  const lease = updateLockPath("codex", root);
  const generation = "00000000-0000-4000-8000-000000000000";
  mkdirSync(`${lease}.recovery`);
  writeFileSync(join(`${lease}.recovery`, "owner"), `99999999:${generation}`);
  writeFileSync(join(root, "codex.completed"), completed ? generation : "before");
  let updates = 0;
  await coordinatedAutoupdate("codex", () => Promise.resolve(void updates++), {
    root,
    pollMs: 1,
    staleMs: 0,
  });
  expect(updates).toBe(completed ? 0 : 1);
  expect(readFileSync(join(root, "codex.completed"), "utf8")).not.toBe("before");
  expect(existsSync(lease)).toBe(false);
  expect(existsSync(`${lease}.recovery`)).toBe(false);
});

test.each([
  "initial",
  "after-claim",
  "open-error",
])("C-PERF-04 %s marker read errors warn without updating or retaining a lease", async (phase) => {
  const root = tempDir("elwood-marker-read-error-");
  const marker = join(root, "codex.completed");
  if (phase === "initial") mkdirSync(marker);
  else if (phase === "open-error") symlinkSync(marker, marker);
  else {
    writeFileSync(marker, "before");
    race.marker = marker;
    race.afterRead = () => {
      unlinkSync(marker);
      mkdirSync(marker);
    };
  }
  resetAutoupdateForTests();
  resetPreflightCacheForTests();
  setPlatformForTests("darwin");
  setUpdateCoordinatorForTests((adapter, update) =>
    coordinatedAutoupdate(adapter, update, { root }),
  );
  let updates = 0;
  setCommandRunnerForTests((_command, args) => {
    if (args.join(" ").includes("codex update")) updates++;
    return { status: 0, stdout: "codex-cli 0.150.0", stderr: "" };
  });
  try {
    await expect(preflightCodex(false, true)).resolves.toMatchObject({
      code: "agent_update_failed",
    });
    expect(updates).toBe(0);
    expect(existsSync(updateLockPath("codex", root))).toBe(false);
  } finally {
    race.afterRead = undefined;
  }
});

const expectedAttempts = { peer: ["peer"], historical: ["caller"] } as const;
test.each([
  "peer",
  "historical",
] as const)("C-PERF-04 pinned baseline distinguishes %s completion", async (scenario) => {
  const root = tempDir("elwood-pinned-baseline-");
  writeFileSync(join(root, "codex.completed"), "before");
  const attempts: string[] = [];
  const run = (name: string) =>
    coordinatedAutoupdate("codex", () => Promise.resolve(void attempts.push(name)), { root });
  race.ownerPath = join(updateLockPath("codex", root), "owner");
  if (scenario === "peer") race.afterMissingOwner = () => run("peer");
  try {
    await run("caller");
    expect(attempts).toEqual(expectedAttempts[scenario]);
  } finally {
    race.afterMissingOwner = undefined;
  }
});
