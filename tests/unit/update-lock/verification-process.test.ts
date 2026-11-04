/** Real lease waiters distinguish verification refusals from attempted update failures (PRD §9.2). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startNodeScript } from "../../helpers/node-script.ts";
import { tempDir } from "../../helpers/tmp.ts";

const moduleUrl = (path: string) => new URL(`../../../src/${path}.ts`, import.meta.url).href;
const childScript = `
  import fs, { access, writeFile } from "node:fs/promises";
  import { syncBuiltinESMExports } from "node:module";
  import { preflightCodex } from ${JSON.stringify(moduleUrl("codex/preflight"))};
  import { setCommandRunnerForTests, setPlatformForTests } from ${JSON.stringify(moduleUrl("runtime/seams"))};
  import { setUpdateCoordinatorForTests } from ${JSON.stringify(moduleUrl("runtime/update/once"))};
  import { coordinatedAutoupdate, updateLockPath } from ${JSON.stringify(moduleUrl("runtime/update/lock"))};
  const { ELWOOD_TEST_ROOT: root, ELWOOD_TEST_ROLE: role, ELWOOD_TEST_CASE: scenario } = process.env;
  const mark = (name, value = "ready") => writeFile(root + "/" + name, value);
  const wait = async (name) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { await access(root + "/" + name); return; } catch {}
      if (Date.now() >= deadline) throw new Error("barrier expired: " + name);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  if (role === "waiter") {
    const nativeStat = fs.stat;
    fs.stat = async (...args) => {
      const result = await nativeStat(...args);
      if (args[0] === updateLockPath("codex", root)) await mark("waiter-observed");
      return result;
    };
    syncBuiltinESMExports();
  }
  setPlatformForTests("darwin");
  setUpdateCoordinatorForTests((adapter, update) => coordinatedAutoupdate(adapter, update, {
    root, pollMs: 5, staleMs: 30_000, waitMs: 10_000,
  }));
  let versions = 0;
  setCommandRunnerForTests(async (_command, args) => {
    if (args.join(" ").includes("codex update")) {
      if (role === "waiter") { await mark("waiter-entered"); await wait("release-waiter"); }
      await mark(role + "-updated");
      return { status: role === "owner" ? 1 : 0, stdout: "", stderr: "installer failed" };
    }
    if (role === "owner" && ++versions === 1) {
      await mark("owner-ready");
      await wait("waiter-observed");
      if (scenario === "refused") return { status: 1, stdout: "", stderr: "verification refused" };
    }
    return { status: 0, stdout: "codex-cli 0.150.0", stderr: "" };
  });
  const warning = await preflightCodex(false, true);
  await mark(role + "-done", JSON.stringify(warning && {
    code: warning.code, errorCode: warning.errorCode, raw: warning.raw,
  }));
`;

for (const scenario of ["refused", "attempted"] as const) {
  test(`C-LIFE-09 a real process waiter ${scenario === "refused" ? "retries a verification refusal" : "shares an attempted update failure"}`, async () => {
    const root = tempDir("elwood-update-verification-process-");
    const completion = join(root, "codex.completed");
    writeFileSync(completion, "previous");
    const owner = runChild(root, "owner", scenario);
    let waiter: ReturnType<typeof runChild> | undefined;
    try {
      await expect
        .poll(() => existsSync(join(root, "owner-ready")), { timeout: 10_000 })
        .toBe(true);
      waiter = runChild(root, "waiter", scenario);
      await expect.poll(() => existsSync(join(root, "owner-done")), { timeout: 10_000 }).toBe(true);
      await expect
        .poll(
          () => existsSync(join(root, "waiter-entered")) || existsSync(join(root, "waiter-done")),
        )
        .toBe(true);
      const refused = scenario === "refused";
      expect(existsSync(join(root, "waiter-entered"))).toBe(refused);
      expect(existsSync(join(root, "owner-updated"))).toBe(!refused);
      expect(readFileSync(completion, "utf8") === "previous").toBe(refused);
      expect(JSON.parse(readFileSync(join(root, "owner-done"), "utf8"))).toEqual({
        code: "agent_update_failed",
        errorCode: refused ? "update_not_started" : "update_failed",
        raw: refused ? "" : "installer failed",
      });
      writeFileSync(join(root, "release-waiter"), "ready");
      expect(await owner.exit).toEqual({ status: 0, stderr: "" });
      expect(await waiter.exit).toEqual({ status: 0, stderr: "" });
      expect(existsSync(join(root, "waiter-updated"))).toBe(refused);
      expect(readFileSync(completion, "utf8")).not.toBe("previous");
    } finally {
      writeFileSync(join(root, "release-waiter"), "ready");
      owner.process.kill();
      waiter?.process.kill();
      await Promise.allSettled([owner.exit, waiter?.exit]);
    }
  });
}

function runChild(root: string, role: string, scenario: string) {
  return startNodeScript(childScript, {
    ELWOOD_TEST_ROOT: root,
    ELWOOD_TEST_ROLE: role,
    ELWOOD_TEST_CASE: scenario,
  });
}
