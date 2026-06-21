/**
 * Conformance tests for package-level developer commands.
 * Covers PRD §11.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type PackageJson = {
  readonly scripts?: Readonly<Record<string, string>>;
};

describe("package scripts", () => {
  test("C-APP-11 example scripts run PTY-owning examples under Node", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
    expect(packageJson.scripts?.["example:minimal"]).toBe(
      "exec node --no-warnings scripts/run-example.ts examples/minimal.ts",
    );
    expect(packageJson.scripts?.["example:full"]).toBe(
      "exec node --no-warnings scripts/run-example.ts examples/full.ts",
    );
  });
});
