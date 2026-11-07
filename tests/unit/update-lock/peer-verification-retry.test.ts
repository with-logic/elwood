/** A peer verification refusal permits a later independent retry (PRD §9.2, C-LIFE-09/11). */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { preflightClaude } from "../../../src/claude/preflight.ts";
import { preflightCodex } from "../../../src/codex/preflight.ts";
import { UpdateVerificationFailure } from "../../../src/core/update-verification.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../../src/runtime/seams.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import {
  cachedAutoupdate,
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../../src/runtime/update/once.ts";
import { tempDir } from "../../helpers/tmp.ts";

const observation = vi.hoisted(() => ({
  ownerPath: "",
  observed: false,
  afterRead: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...args);
      if (String(args[0]) === observation.ownerPath) {
        observation.observed = true;
        const after = observation.afterRead;
        observation.afterRead = undefined;
        await after?.();
      }
      return result;
    },
  };
});

test.each([
  { agent: "claude", preflight: preflightClaude, version: "2.1.305", mode: "wait" },
  { agent: "codex", preflight: preflightCodex, version: "codex-cli 0.150.0", mode: "claim" },
  { agent: "codex", preflight: preflightCodex, version: "codex-cli 0.150.0", mode: "next" },
] as const)("C-LIFE-09/11 $agent retries after peer verification refusal ($mode)", async ({
  agent,
  preflight,
  version,
  mode,
}) => {
  const root = tempDir("elwood-peer-verification-");
  const entered = join(root, "entered");
  const release = join(root, "release");
  const source = (path: string) => new URL(`../../../src/${path}`, import.meta.url).href;
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    import { preflight${agent === "claude" ? "Claude" : "Codex"} as preflight } from ${JSON.stringify(source(`${agent}/preflight.ts`))};
    import { setCommandRunnerForTests, setPlatformForTests } from ${JSON.stringify(source("runtime/seams.ts"))};
    import { coordinatedAutoupdate } from ${JSON.stringify(source("runtime/update/lock.ts"))};
    import { setUpdateCoordinatorForTests } from ${JSON.stringify(source("runtime/update/once.ts"))};
    setPlatformForTests("darwin");
    setUpdateCoordinatorForTests((adapter, update) =>
      coordinatedAutoupdate(adapter, update, { root: ${JSON.stringify(root)}, pollMs: 1, staleMs: 0, waitMs: 1_000 }));
    let first = true, updates = 0;
    setCommandRunnerForTests(async (_shell, args) => {
      if (args.join(" ").includes(${JSON.stringify(`${agent} update`)})) {
        return { status: 0, stdout: String(updates++), stderr: "" };
      }
      if (first) {
        first = false;
        writeFileSync(${JSON.stringify(entered)}, "");
        while (!existsSync(${JSON.stringify(release)})) await delay(1);
        return { status: 9, stdout: "", stderr: "verification refused" };
      }
      return { status: 0, stdout: ${JSON.stringify(version)}, stderr: "" };
    });
    const warning = await preflight(false, true);
    console.log(JSON.stringify({ updates, warning }));
  `;
  const owner = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = owner.stdout.toArray().then((chunks) => chunks.join(""));
  const stderr = owner.stderr.toArray().then((chunks) => chunks.join(""));
  const exited = once(owner, "close").then(() => owner.exitCode);
  let pending: ReturnType<typeof preflight> | undefined;
  let successor: Promise<void> | undefined;
  const finishSuccessor = Promise.withResolvers<void>();
  let updates = 0;
  try {
    await expect.poll(() => existsSync(entered), { timeout: 5_000 }).toBe(true);
    observation.ownerPath = join(updateLockPath(agent, root), "owner");
    observation.observed = false;
    resetPreflightCacheForTests();
    setPlatformForTests("darwin");
    setUpdateCoordinatorForTests((adapter, update) =>
      coordinatedAutoupdate(adapter, update, { root, pollMs: 1, staleMs: 0, waitMs: 1_000 }),
    );
    setCommandRunnerForTests((_shell, args) => {
      if (args.join(" ").includes(`${agent} update`)) updates++;
      return { status: 0, stdout: version, stderr: "" };
    });
    if (mode !== "wait") {
      observation.afterRead = async () => {
        writeFileSync(release, "");
        await exited;
        if (mode === "claim") return;
        let admitted = false;
        successor = coordinatedAutoupdate(
          agent,
          async () => {
            admitted = true;
            await finishSuccessor.promise;
            throw new UpdateVerificationFailure(undefined);
          },
          { root, pollMs: 1, staleMs: 0, waitMs: 1_000 },
        );
        await expect.poll(() => admitted, { timeout: 1_000 }).toBe(true);
        // The waiting caller must observe B after its snapshot pinned A.
        observation.afterRead = async () => {
          finishSuccessor.resolve();
          await expect(successor).rejects.toBeInstanceOf(UpdateVerificationFailure);
        };
      };
    }
    // Observe A's owned verification before A refuses and releases.
    pending = preflight(false, true);
    await expect.poll(() => observation.observed, { timeout: 5_000 }).toBe(true);
    writeFileSync(release, "");
    const peerWarning = await pending;
    expect(await exited, await stderr).toBe(0);
    expect(JSON.parse(await stdout)).toMatchObject({
      updates: 0,
      warning: { message: expect.stringContaining("skipped before invocation") },
    });
    expect(existsSync(join(root, `${agent}.completed`))).toBe(false);
    expect(updates).toBe(0);
    await preflight(false, true);
    expect(updates).toBe(1);
    expect(peerWarning).toMatchObject({
      code: "agent_update_failed",
      errorCode: "update_failed",
      raw: "",
    });
  } finally {
    writeFileSync(release, "");
    owner.kill("SIGKILL");
    finishSuccessor.resolve();
    await Promise.allSettled([exited, pending, successor]);
  }
});

test("C-LIFE-09 stale A receipt cannot authorize C after B invokes", async () => {
  const root = tempDir("elwood-refusal-successor-");
  const receipt = join(root, "codex.completed.refused");
  const failure = new UpdateVerificationFailure(undefined);
  const finish = Promise.withResolvers<void>();
  let entered = false;
  await expect(
    coordinatedAutoupdate("codex", () => Promise.reject(failure), { root }),
  ).rejects.toBe(failure);
  const refusedA = readFileSync(receipt, "utf8");
  const successor = coordinatedAutoupdate(
    "codex",
    async () => {
      expect(existsSync(receipt)).toBe(false);
      entered = true;
      await finish.promise;
    },
    { root, pollMs: 1, staleMs: 0, waitMs: 1_000 },
  );
  try {
    await expect.poll(() => entered, { timeout: 1_000 }).toBe(true);
    observation.ownerPath = join(updateLockPath("codex", root), "owner");
    observation.afterRead = async () => {
      finish.resolve();
      await successor;
      // Even a stale externally restored receipt cannot describe B's observed generation.
      writeFileSync(receipt, refusedA);
    };
    resetAutoupdateForTests();
    setUpdateCoordinatorForTests((adapter, update) =>
      coordinatedAutoupdate(adapter, update, { root, pollMs: 1, staleMs: 0, waitMs: 1_000 }),
    );
    let attempts = 0;
    const outcome = await cachedAutoupdate("codex", () => Promise.resolve(void attempts++));
    expect(outcome).toEqual({ ok: true });
    expect(await cachedAutoupdate("codex", () => Promise.resolve(void attempts++))).toBe(outcome);
    expect(attempts).toBe(0);
  } finally {
    observation.afterRead = undefined;
    finish.resolve();
    await successor;
  }
});
