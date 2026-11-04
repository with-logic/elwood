/** Failed claims and retiring peer paths preserve completion evidence (PRD §9.2, C-PERF-04). */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { acquireUpdateLease } from "../../../src/runtime/update/acquire.ts";
import { tempDir } from "../../helpers/tmp.ts";
import { writeUpdateCompletion } from "../../helpers/update-completion.ts";

const generation = "00000000-0000-4000-8000-00000000000a";
const race = vi.hoisted(() => ({ path: "", beforeRename: () => {} }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (...args: Parameters<typeof actual.rename>) => {
      if (String(args[0]) === race.path) race.beforeRename();
      return actual.rename(...args);
    },
  };
});

function options(root: string, claim: Parameters<typeof acquireUpdateLease>[0]["claim"]) {
  return {
    adapter: "codex",
    leasePath: join(root, "codex.lock"),
    owner: { pid: process.pid, token: "c" },
    completionMarkerPath: join(root, "codex.completed"),
    refusalReceiptPath: join(root, "codex.refused"),
    pollMs: 1,
    staleMs: 0,
    waitUntilMs: performance.now() + 1_000,
    claim,
  } as const;
}

test.each([
  "changed-evidence",
  "observed-owner",
] as const)("C-PERF-04 unavailable claim with %s remains unconfirmed", async (evidence) => {
  const root = tempDir("elwood-unavailable-peer-");
  const lease = join(root, "codex.lock");
  if (evidence === "observed-owner") {
    mkdirSync(lease);
    writeFileSync(join(lease, "owner"), `${process.pid}:${generation}`);
  }
  let claims = 0;
  const result = acquireUpdateLease(
    options(root, () => {
      claims++;
      if (evidence === "changed-evidence") writeFileSync(join(root, "codex.completed"), generation);
      else rmSync(lease, { recursive: true });
      return Promise.resolve("unavailable");
    }),
  );
  await expect(result).rejects.toMatchObject({
    code: "codex_update_failed",
    details: { updateOutcome: "unconfirmed" },
  });
  expect(claims).toBe(1);
  expect(existsSync(lease)).toBe(false);
});

test("C-PERF-04 recovery losing an already-completed peer path still skips its duplicate", async () => {
  const root = tempDir("elwood-retiring-confirmed-peer-");
  const lease = join(root, "codex.lock");
  const completion = join(root, "codex.completed");
  mkdirSync(lease);
  writeFileSync(join(lease, "owner"), `99999999:${generation}`);
  let retired = false;
  let claims = 0;
  race.path = lease;
  race.beforeRename = () => {
    // The peer publishes and retires after recovery's identity read, before its rename.
    writeUpdateCompletion(completion, generation);
    rmSync(lease, { recursive: true });
    retired = true;
  };
  try {
    const result = await acquireUpdateLease(
      options(root, () => {
        claims++;
        return Promise.resolve("contended");
      }),
    );
    expect(result).toBe(false);
    expect(retired).toBe(true);
    expect(claims).toBe(1);
    expect(readFileSync(completion, "utf8")).toBe(generation);
    expect(existsSync(lease)).toBe(false);
  } finally {
    race.beforeRename = () => {};
    race.path = "";
  }
});
