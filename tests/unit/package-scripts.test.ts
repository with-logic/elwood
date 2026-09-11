/**
 * Conformance tests for package-level developer commands.
 * Covers PRD §11 and §12.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

type PackageJson = {
  readonly bin?: Readonly<Record<string, string>>;
  readonly engines?: Readonly<Record<string, string>>;
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly files?: readonly string[];
  readonly main?: string;
  readonly module?: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly types?: string;
};

describe("package scripts", () => {
  test("C-APP-11 example and dev:web scripts run their entry under the Node supervisor", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
    const supervised = ["dev:web", "example:minimal", "example:stream", "example:full"];
    for (const name of supervised) {
      const script = packageJson.scripts?.[name];
      const match = /^exec node --no-warnings scripts\/supervise\.ts (\S+)$/.exec(script ?? "");
      expect(match, `${name}: ${script}`).not.toBeNull();
      expect(existsSync("scripts/supervise.ts")).toBe(true);
      expect(existsSync(match?.[1] ?? ""), `${name} entry exists`).toBe(true);
    }
    expect(packageJson.scripts?.["dev:web"]).toContain("src/app/web-dev.ts");
  });

  test("C-E2E-05 check:all runs the default check gate followed by test:e2e", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
    expect(packageJson.scripts?.["check:all"]).toBe("npm run check && npm run test:e2e");
    expect(packageJson.scripts?.["check"]).not.toContain("test:e2e");
  });

  test("C-CLI-01 package scripts emit the installed JavaScript boundary", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
    expect(packageJson.scripts?.["build"]).toBe(
      "tsc -p tsconfig.build.json && node scripts/postbuild.mjs",
    );
    expect(packageJson.scripts?.["prepare"]).toBe("npm run build");
    expect(packageJson.scripts?.["check"]).toMatch(/^npm run build &&/u);
    expect(packageJson.main).toBe("./dist/index.js");
    expect(packageJson.module).toBe("./dist/index.js");
    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    });
    expect(packageJson.bin).toEqual({ elwood: "./dist/cli/entry.js" });
    expect(packageJson.engines).toEqual({ node: ">=24" });
    expect(packageJson.files).toContain("dist");
    expect(packageJson.files).not.toContain("src");
  });
});
