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

test.each([
  "version",
  "capability",
] as const)("C-PERF-02 %s caches do not cross child environments", async (kind) => {
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
  const read = (env: Readonly<Record<string, string | undefined>> | undefined) => {
    const directory = { cwd, ...(env === undefined ? {} : { env }) };
    return kind === "version"
      ? cachedVersionRead("codex", (options) => runner("shell", [], options), directory)
      : detectCodexCliCapabilities(directory);
  };
  for (const env of [
    undefined,
    { ELWOOD_ENV_VALUE: "--dangerously-bypass-hook-trust" },
    { ELWOOD_ENV_VALUE: "other" },
  ]) {
    const result = await read(env);
    expect(result).toEqual(
      kind === "version"
        ? { status: 0, stdout: env?.["ELWOOD_ENV_VALUE"] ?? "default", stderr: "" }
        : {
            supportsHookTrustBypass:
              env?.["ELWOOD_ENV_VALUE"] === "--dangerously-bypass-hook-trust",
          },
    );
    await read(env && { ...env });
  }
  expect(runner).toHaveBeenCalledTimes(3);
});
