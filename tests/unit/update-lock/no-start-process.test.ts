/** A no-start lease owner publishes no completion; a real peer retries its own cwd (C-LIFE-09). */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { tempDir } from "../../helpers/tmp.ts";

const onceUrl = new URL("../../../src/runtime/update/once.ts", import.meta.url).href;
const lockUrl = new URL("../../../src/runtime/update/lock.ts", import.meta.url).href;
const probeUrl = new URL("../../../src/runtime/probe/index.ts", import.meta.url).href;
const script = `
  import fs, { access, mkdir, rename, stat, writeFile } from "node:fs/promises";
  import { syncBuiltinESMExports } from "node:module";
  import { join } from "node:path";
  import { cachedAutoupdate, setUpdateCoordinatorForTests } from ${JSON.stringify(onceUrl)};
  import { coordinatedAutoupdate, updateLockPath } from ${JSON.stringify(lockUrl)};
  import { runProbe } from ${JSON.stringify(probeUrl)};
  const root = process.env.ELWOOD_TEST_LEASE_ROOT;
  const role = process.env.ELWOOD_TEST_LEASE_ROLE;
  const cwd = join(root, role);
  const identity = await stat(cwd, { bigint: true });
  const mark = (name) => writeFile(join(root, name), "");
  const wait = async (name) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { await access(join(root, name)); return; } catch {}
      if (Date.now() >= deadline) throw new Error("barrier timed out: " + name);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  if (role === "waiter") {
    const realStat = fs.stat;
    fs.stat = async (...args) => {
      const result = await realStat(...args);
      if (args[0] === updateLockPath("codex", root)) await mark("waiter-observed");
      return result;
    };
    syncBuiltinESMExports();
  }
  setUpdateCoordinatorForTests((adapter, update) => coordinatedAutoupdate(adapter, update, { root, pollMs: 5 }));
  const outcome = await cachedAutoupdate("codex", cwd, {
    verify: async () => {
      if (role === "owner") { await mark("owner-ready"); await wait("waiter-observed"); }
    },
    update: async () => {
      if (role === "owner" && process.env.ELWOOD_TEST_LEASE_OUTCOME === "refused") {
        await rename(cwd, join(root, "original"));
        await rename(join(root, "replacement"), cwd);
        const result = await runProbe("/bin/sh", ["-c", "touch updated-in"], { cwd, identity });
        if (result.started !== false) throw new Error("expected a real directory refusal");
        return { started: false };
      }
      if (role === "waiter") { await mark("waiter-entered"); await wait("release-waiter"); }
      await writeFile(join(cwd, "updated-in"), cwd);
    },
  });
  if (!outcome.ok) throw outcome.error;
  await mark(role + "-done");
`;

function run(root: string, role: "owner" | "waiter", outcome: string) {
  const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
    env: {
      ...process.env,
      ELWOOD_TEST_LEASE_ROOT: root,
      ELWOOD_TEST_LEASE_ROLE: role,
      ELWOOD_TEST_LEASE_OUTCOME: outcome,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4096);
  });
  const done = new Promise<number | null>((resolve) => child.on("close", resolve));
  return { child, done, diagnostic: () => stderr };
}

test.each([
  "refused",
  "completed",
] as const)("C-LIFE-09 a real lease waiter handles a %s owner without duplicating a completed update", async (outcome) => {
  const root = tempDir("elwood-no-start-lease-");
  for (const name of ["owner", "waiter", "replacement"]) mkdirSync(join(root, name));
  const completion = join(root, "codex.completed");
  writeFileSync(completion, "previous");
  const owner = run(root, "owner", outcome);
  let waiter: ReturnType<typeof run> | undefined;
  const marked = (name: string) =>
    expect.poll(() => existsSync(join(root, name)), { timeout: 5000 }).toBe(true);
  try {
    await marked("owner-ready");
    waiter = run(root, "waiter", outcome);
    await marked("owner-done");
    if (outcome === "refused") {
      expect(readFileSync(completion, "utf8")).toBe("previous");
      await expect
        .poll(() => existsSync(join(root, "waiter-entered")) || waiter?.child.exitCode !== null, {
          timeout: 5000,
        })
        .toBe(true);
      expect(existsSync(join(root, "waiter-entered")), waiter.diagnostic()).toBe(true);
      expect(existsSync(join(root, "owner", "updated-in"))).toBe(false);
    }
    writeFileSync(join(root, "release-waiter"), "");
    expect(await owner.done, owner.diagnostic()).toBe(0);
    expect(await waiter.done, waiter.diagnostic()).toBe(0);
    expect(existsSync(join(root, "waiter", "updated-in"))).toBe(outcome === "refused");
    expect(existsSync(join(root, "owner", "updated-in"))).toBe(outcome === "completed");
    expect(readFileSync(completion, "utf8")).not.toBe("previous");
  } finally {
    writeFileSync(join(root, "release-waiter"), "");
    for (const process of [owner, waiter])
      if (process?.child.exitCode === null) process.child.kill("SIGKILL");
    await Promise.allSettled([owner.done, waiter?.done]);
  }
});
