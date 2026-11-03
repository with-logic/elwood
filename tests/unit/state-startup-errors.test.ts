/** Native setup failures remain typed at both public startup boundaries (PRD §9.1/§10, C-ERR-08). */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

const fault = vi.hoisted(() => ({ write: false, cleanup: false }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fault.write)
        throw Object.assign(new Error("write refused"), { code: "EIO", syscall: "write" });
      return actual.writeFileSync(...args);
    },
    unlinkSync: (path: string) => {
      if (fault.cleanup) throw Object.assign(new Error("cleanup refused"), { code: "EPERM" });
      return actual.unlinkSync(path);
    },
  };
});
afterEach(() => {
  fault.write = false;
  fault.cleanup = false;
  resetRuntimeSeamsForTests();
  resetPreflightCacheForTests();
});

for (const [agent, start] of [
  ["claude", startClaude],
  ["codex", startCodex],
] as const) {
  test(`C-ERR-08 ${agent} startup retains native setup and cleanup diagnostics`, async () => {
    const cwd = tempDir("elwood-typed-setup-");
    setPlatformForTests("darwin");
    setCommandRunnerForTests(() => ({ status: 0, stdout: "99.0.0", stderr: "" }));
    const spawn = vi.fn(() => {
      throw new Error("no PTY may start");
    });
    setPtyFactoryForTests(spawn);
    fault.write = true;
    fault.cleanup = true;
    await expect(start({ cwd })).rejects.toMatchObject({
      code: `${agent}_start_failed`,
      details: {
        cause: "write refused",
        errno: "EIO",
        syscall: "write",
        cleanupErrorCode: "EPERM",
      },
    });
    expect(spawn).not.toHaveBeenCalled();
  });
  test(`C-STATE-01 ${agent} startup preserves an existing typed validation error`, async () => {
    const cwd = tempDir("elwood-typed-existing-");
    const root = join(cwd, ".elwood");
    fs.mkdirSync(root);
    fs.symlinkSync(join(cwd, "absent"), join(root, ".gitignore"));
    setPlatformForTests("darwin");
    setCommandRunnerForTests(() => ({ status: 0, stdout: "99.0.0", stderr: "" }));
    await expect(start({ cwd })).rejects.toMatchObject({ code: "state_corrupt" });
  });
}
