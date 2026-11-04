/** CLI root setup and adapter start retain the same workspace identity (C-API-61, C-STATE-14). */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createCliLaunch, defaultCliLaunchDependencies } from "../../src/cli/session/launch.ts";
import {
  setCommandRunnerForTests,
  setPlatformForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";
import { effectiveRequest } from "./main-fakes.ts";

const race = vi.hoisted(() => ({ path: "", swap: () => {} }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: (path: string, options?: fs.MakeDirectoryOptions) => {
      if (path === race.path) {
        race.path = "";
        race.swap();
      }
      return actual.mkdirSync(path, options);
    },
  };
});
beforeEach(() => {
  setPlatformForTests("darwin");
  resetPreflightCacheForTests();
});
afterEach(() => {
  race.path = "";
});

for (const agent of ["claude", "codex"] as const) {
  test.each([
    "root",
    "sessions",
    "handoff",
    "removed",
    "session",
  ])(`C-API-61 C-STATE-14 CLI ${agent} rejects a workspace change at %s`, async (at) => {
    const base = fs.realpathSync(tempDir("elwood-cli-state-identity-"));
    const cwd = join(base, "worktree");
    const replacement = join(base, "replacement");
    const stateDir = join(base, "state");
    fs.mkdirSync(cwd);
    fs.mkdirSync(replacement);
    const swap = () => {
      fs.renameSync(cwd, join(base, "original"));
      fs.renameSync(replacement, cwd);
    };
    const probes = vi.fn(() => ({ status: 0, stdout: "2.1.223", stderr: "" }));
    const launches = vi.fn(() => {
      throw new Error("unexpected PTY launch");
    });
    setCommandRunnerForTests(probes);
    setPtyFactoryForTests(launches);
    if (at === "root" || at === "sessions" || at === "session") {
      race.path =
        at === "root"
          ? stateDir
          : at === "sessions"
            ? join(stateDir, "sessions")
            : join(stateDir, "sessions", "checked");
      race.swap = swap;
    }
    const launch = createCliLaunch(effectiveRequest({ agent, cwd, stateDir }), "checked", {
      ...defaultCliLaunchDependencies,
      prepareStateRoot: (...args) => {
        defaultCliLaunchDependencies.prepareStateRoot(...args);
        if (at === "handoff") swap();
        if (at === "removed") fs.rmSync(cwd, { recursive: true });
      },
    });
    await expect(launch()).rejects.toMatchObject({
      code: `${agent}_start_failed`,
      details: { cwd },
    });
    if (at === "root" || at === "sessions") expect(fs.existsSync(stateDir)).toBe(false);
    if (at === "session") {
      expect(probes).toHaveBeenCalled();
      expect(fs.existsSync(join(stateDir, "sessions", "checked"))).toBe(false);
    } else expect(probes).not.toHaveBeenCalled();
    expect(launches).not.toHaveBeenCalled();
  });
}

test("C-API-61 unsupported CLI launches retain platform precedence at synchronous checkpoints", async () => {
  setPlatformForTests("linux");
  const cwd = tempDir("elwood-cli-platform-");
  const launch = createCliLaunch(
    effectiveRequest({ cwd, stateDir: join(cwd, "state") }),
    "unsupported",
    defaultCliLaunchDependencies,
  );
  await expect(launch()).rejects.toMatchObject({ code: "unsupported_platform" });
});

test("C-STATE-14 identity-free CLI setup removes new external scaffolding when cwd disappears", async () => {
  setPlatformForTests("linux");
  const base = fs.realpathSync(tempDir("elwood-cli-identity-free-"));
  const cwd = join(base, "worktree");
  const created = join(base, "created");
  const stateDir = join(created, "state");
  fs.mkdirSync(cwd);
  race.path = stateDir;
  race.swap = () => fs.rmSync(cwd, { recursive: true });
  const probes = vi.fn(() => ({ status: 0, stdout: "2.1.223", stderr: "" }));
  const launches = vi.fn(() => {
    throw new Error("unexpected PTY launch");
  });
  setCommandRunnerForTests(probes);
  setPtyFactoryForTests(launches);
  const launch = createCliLaunch(
    effectiveRequest({ cwd, stateDir }),
    "identity-free",
    defaultCliLaunchDependencies,
  );
  const result = await launch().catch((error: unknown) => error);
  expect(fs.existsSync(cwd)).toBe(false);
  expect(fs.existsSync(created)).toBe(false);
  expect(result).toMatchObject({ code: "ENOENT", syscall: "realpath", path: cwd });
  expect(probes).not.toHaveBeenCalled();
  expect(launches).not.toHaveBeenCalled();
});
