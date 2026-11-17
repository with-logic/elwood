/** Effective inherited environments are copied and widened at launch (PRD §5.1, §5.5). */
import { afterEach, expect, expectTypeOf, test, vi } from "vitest";
import { type ChildEnvironment, snapshotEnvironment } from "../../src/runtime/environment.ts";

afterEach(() => vi.unstubAllEnvs());

test("C-API-26 snapshot environments widen literal overrides and retain other option types", () => {
  vi.stubEnv("ELWOOD_ENV_INHERIT", "inherited");
  const options = snapshotEnvironment({
    env: { ELWOOD_ENV_VALUE: "override" as const },
    cwd: "cwd" as const,
  });
  expectTypeOf(options.env).toEqualTypeOf<ChildEnvironment>();
  expectTypeOf(options.cwd).toEqualTypeOf<"cwd">();
  expect(options.env).toMatchObject({
    ELWOOD_ENV_VALUE: "override",
    ELWOOD_ENV_INHERIT: "inherited",
  });
});
