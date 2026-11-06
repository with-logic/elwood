/** Local verification refusals do not complete or poison updates (PRD §9.2, C-LIFE-09/11). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { elwoodError } from "../../src/core/errors.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../src/runtime/update/lock.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

const adapters = [
  { agent: "claude", preflight: preflightClaude, version: "2.1.305" },
  { agent: "codex", preflight: preflightCodex, version: "codex-cli 0.150.0" },
] as const;
beforeEach(() => {
  resetAutoupdateForTests();
  resetPreflightCacheForTests();
  setPlatformForTests("darwin");
});

test.each(
  adapters.flatMap((adapter) => [false, true].map((persistent) => ({ ...adapter, persistent }))),
)("C-LIFE-09/11 $agent shares one verification refusal (persistent=$persistent), then retries independently", async ({
  agent,
  preflight,
  version,
  persistent,
}) => {
  const root = tempDir("elwood-verification-");
  const marker = join(root, `${agent}.completed`);
  const previous = "00000000-0000-4000-8000-00000000000a";
  writeFileSync(marker, previous);
  let coordinations = 0;
  setUpdateCoordinatorForTests((adapter, update) => {
    coordinations++;
    return coordinatedAutoupdate(adapter, update, { root });
  });
  let entered = false;
  const release = Promise.withResolvers<void>();
  let reads = 0;
  let updates = 0;
  let refusing = true;
  setCommandRunnerForTests(async (_shell, args) => {
    if (args.join(" ").includes(`${agent} update`)) {
      updates++;
      return { status: 0, stdout: "", stderr: "" };
    }
    const first = ++reads === 1;
    if (first) {
      expect(existsSync(updateLockPath(agent, root))).toBe(true);
      entered = true;
      await release.promise;
    }
    return refusing && (first || persistent)
      ? { status: 9, stdout: "private verifier output", stderr: "private verifier error" }
      : { status: 0, stdout: version, stderr: "" };
  });
  const cohort = Promise.allSettled(Array.from({ length: 50 }, () => preflight(false, true)));
  try {
    await expect.poll(() => entered, { timeout: 1_000 }).toBe(true);
  } finally {
    release.resolve();
    await cohort;
  }
  const outcomes = await cohort;
  expect(coordinations).toBe(1);
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(updates).toBe(0);
  expect.soft(readFileSync(marker, "utf8")).toBe(previous);
  expect(existsSync(updateLockPath(agent, root))).toBe(false);
  for (const outcome of outcomes) {
    if (persistent) {
      expect
        .soft(outcome)
        .toMatchObject({ status: "rejected", reason: { code: `${agent}_start_failed` } });
    } else {
      expect.soft(outcome).toMatchObject({
        status: "fulfilled",
        value: {
          code: "agent_update_failed",
          errorCode: "update_failed",
          raw: "",
          message: expect.stringContaining("skipped before invocation"),
        },
      });
      if (outcome.status === "fulfilled")
        expect.soft(outcome.value).not.toHaveProperty("exitStatus");
    }
  }
  refusing = false;
  await expect.soft(preflight(false, true)).resolves.toBeUndefined();
  expect.soft(coordinations).toBe(2);
  expect.soft(updates).toBe(1);
  expect(readFileSync(marker, "utf8")).not.toBe(previous);
});

test.each(
  adapters,
)("C-LIFE-11 $agent retains an actual undefined updater rejection and warns", async ({
  agent,
  preflight,
  version,
}) => {
  let updates = 0;
  setUpdateCoordinatorForTests((_adapter, update) => update());
  setCommandRunnerForTests((_shell, args) => {
    if (args.join(" ").includes(`${agent} update`)) {
      updates++;
      return Promise.reject(undefined);
    }
    return { status: 0, stdout: version, stderr: "" };
  });
  for (let call = 0; call < 2; call++)
    await expect(preflight(false, true)).resolves.toMatchObject({
      code: "agent_update_failed",
      errorCode: "update_failed",
    });
  expect.soft(updates).toBe(1);
});

test("C-LIFE-09 a pre-callback coordination rejection is shared once, then retried", async () => {
  let entered = false;
  const release = Promise.withResolvers<void>();
  let calls = 0;
  setUpdateCoordinatorForTests(async (_adapter, update) => {
    if (++calls === 1) {
      entered = true;
      await release.promise;
      throw elwoodError("claude_update_failed", "active", { updateReason: "active_owner" });
    }
    await update();
  });
  setCommandRunnerForTests(() => ({ status: 0, stdout: "2.1.305", stderr: "" }));
  const cohort = Promise.all(Array.from({ length: 50 }, () => preflightClaude(false, true)));
  try {
    await expect.poll(() => entered, { timeout: 1_000 }).toBe(true);
  } finally {
    release.resolve();
    await cohort;
  }
  for (const warning of await cohort) expect(warning).toMatchObject({ errorCode: "update_active" });
  expect(calls).toBe(1);
  await expect(preflightClaude(false, true)).resolves.toBeUndefined();
  expect(calls).toBe(2);
});
