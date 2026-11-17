/** Environment-specific probe execution and cache isolation (PRD §5.1, §5.5, C-PERF-02). */
import { afterEach, expect, test, vi } from "vitest";
import {
  detectCodexCliCapabilities,
  resetCodexPreflightCacheForTests,
} from "../../src/codex/preflight.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { cachedVersionRead, resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => {
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
  vi.unstubAllEnvs();
});

test("C-PERF-02 a real probe receives its supplied child environment", async () => {
  vi.stubEnv("ELWOOD_ENV_PARENT", "parent-only");
  const result = await runProbe(
    process.execPath,
    [
      "-e",
      "process.stdout.write(JSON.stringify([process.env.ELWOOD_ENV_CHILD,process.env.ELWOOD_ENV_PARENT]))",
    ],
    { env: { ELWOOD_ENV_CHILD: "child-only" } },
  );
  expect(result).toEqual({ status: 0, stdout: '["child-only",null]', stderr: "" });
  expect(process.env["ELWOOD_ENV_PARENT"]).toBe("parent-only");
});

function cacheHarness() {
  const cwd = tempDir("elwood-env-cache-");
  const runner = vi.fn(
    async (
      _shell: string,
      _args: readonly string[],
      options?: { readonly env?: Readonly<Record<string, string | undefined>> },
    ) => ({
      status: 0,
      stdout: options?.env?.["ELWOOD_ENV_VALUE"] ?? "default",
      stderr: "",
    }),
  );
  setCommandRunnerForTests(runner);
  return { cwd, runner };
}

test("C-PERF-02 version caches do not cross child environments", async () => {
  const { cwd, runner } = cacheHarness();
  for (const [directory, expected] of [
    [{ cwd }, "default"],
    [
      { cwd, env: { ELWOOD_ENV_VALUE: "--dangerously-bypass-hook-trust" } },
      "--dangerously-bypass-hook-trust",
    ],
    [{ cwd, env: { ELWOOD_ENV_VALUE: "other" } }, "other"],
  ] as const) {
    const read = () =>
      cachedVersionRead("codex", (options) => runner("shell", [], options), { ...directory });
    expect(await read()).toEqual({ status: 0, stdout: expected, stderr: "" });
    await read();
  }
  expect(runner).toHaveBeenCalledTimes(3);
});

test("C-PERF-02 capability caches do not cross child environments", async () => {
  const { cwd, runner } = cacheHarness();
  for (const [directory, expected] of [
    [{ cwd }, false],
    [{ cwd, env: { ELWOOD_ENV_VALUE: "--dangerously-bypass-hook-trust" } }, true],
    [{ cwd, env: { ELWOOD_ENV_VALUE: "other" } }, false],
  ] as const) {
    expect(await detectCodexCliCapabilities({ ...directory })).toEqual({
      supportsHookTrustBypass: expected,
    });
    await detectCodexCliCapabilities({ ...directory });
  }
  expect(runner).toHaveBeenCalledTimes(3);
});
