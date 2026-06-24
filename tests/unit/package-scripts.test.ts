/**
 * Conformance tests for package-level developer commands.
 * Covers PRD §11.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

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

  test("C-APP-11 full example has runnable defaults", () => {
    const fullExample = readFileSync("examples/full.ts", "utf8");
    expect(fullExample).toContain("const defaultPrompt");
    expect(fullExample).toContain("let prompt = defaultPrompt");
    expect(fullExample).not.toContain("Missing required --prompt");
  });
});
