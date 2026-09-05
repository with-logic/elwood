/**
 * Metadata, config, and run-routing tests for the side-effect-free CLI main (PRD §12A.1).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../../src/cli/main.ts";
import type { ParsedRunCommand } from "../../src/cli/types.ts";
import { mainDependencies, mainHarness, resolvedRequest } from "./main-fakes.ts";

describe("CLI main routing", () => {
  test.each(
    ["help", "--help", "-h"].map((arg) => ({ args: [arg] })),
  )("C-CLI-02 $args bypasses config and execution", async ({ args }) => {
    const h = mainHarness();
    const dependencies = mainDependencies({
      resolve: () => Promise.reject(new Error("must not resolve")),
    });
    expect(await main(args, h.context, dependencies)).toBe(0);
    expect(h.stdout.value).toContain("Usage: elwood");
    expect(h.stderr.value).toBe("");
  });

  test.each(
    ["--version", "-V"].map((arg) => ({ args: [arg] })),
  )("C-CLI-02 $args prints only the version", async ({ args }) => {
    const h = mainHarness();
    expect(await main(args, h.context, mainDependencies())).toBe(0);
    expect(h.stdout.value).toBe("9.8.7\n");
    expect(h.stderr.value).toBe("");
  });

  test("C-CLI-02 direct, explicit run, and post-double-dash prompts route equivalently", async () => {
    const prompts: readonly string[][] = [];
    const mutable = prompts as string[][];
    const dependencies = mainDependencies({
      resolve: (parsed) => {
        mutable.push([...(parsed as ParsedRunCommand).promptWords]);
        return Promise.resolve(resolvedRequest());
      },
    });
    for (const args of [["hello"], ["run", "hello"], ["--", "help"]]) {
      const h = mainHarness();
      expect(await main(args, h.context, dependencies)).toBe(0);
    }
    expect(prompts).toEqual([["hello"], ["hello"], ["help"]]);
  });

  test("C-CLI-14 config commands route without resolving a run", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-main-config-"));
    const h = mainHarness();
    const context = {
      ...h.context,
      env: { ELWOOD_CONFIG: join(root, "config.json") },
      invocationCwd: root,
    };
    const dependencies = mainDependencies({
      resolve: () => Promise.reject(new Error("must not resolve")),
    });
    expect(await main(["config", "set", "agent", "claude"], context, dependencies)).toBe(0);
    h.stdout.value = "";
    expect(await main(["config", "get", "agent"], context, dependencies)).toBe(0);
    expect(h.stdout.value).toBe("claude\n");
  });
});
