/**
 * Metadata, config, and run-routing tests for the side-effect-free CLI main (PRD §12A.1).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { executeDefaultCliRun, main, prepareDefaultCliSession } from "../../src/cli/main.ts";
import type { ParsedRunCommand } from "../../src/cli/types.ts";
import { effectiveRequest, mainDependencies, mainHarness, resolvedRequest } from "./main-fakes.ts";
import { FakeCliSession } from "./run-fakes.ts";

describe("CLI main routing", () => {
  test.each(
    [[], ["help"], ["--help"], ["-h"]].map((args) => ({ args })),
  )("C-CLI-02 $args bypasses config and execution", async ({ args }) => {
    const h = mainHarness();
    const dependencies = mainDependencies({
      resolve: () => Promise.reject(new Error("must not resolve")),
    });
    expect(await main(args, h.context, dependencies)).toBe(0);
    expect(h.stdout.value).toContain("Usage: elwood");
    expect(h.stderr.value).toBe("");
  });

  test("C-CLI-18 requires a terminal and passes its size and display to execution", async () => {
    const unavailable = mainHarness();
    const dependencies = mainDependencies({
      resolve: () => Promise.resolve(resolvedRequest({ head: true })),
      prepare: () => Promise.reject(new Error("must not prepare")),
    });
    expect(await main(["--head", "go"], unavailable.context, dependencies)).toBe(2);
    expect(unavailable.stderr.value).toContain("terminal stdin and stderr");

    const available = mainHarness();
    const terminal = available.headTarget({ cols: 117, rows: 39 });
    const prepared = effectiveRequest({ initialSize: { cols: 117, rows: 39 } });
    let executionSize: { readonly cols: number; readonly rows: number } | undefined;
    expect(
      await main(
        ["--head", "go"],
        { ...available.context, head: terminal.target },
        mainDependencies({
          resolve: () => Promise.resolve(resolvedRequest({ head: true })),
          prepare: (draft) => {
            expect(draft.initialSize).toEqual({ cols: 117, rows: 39 });
            return Promise.resolve({ request: prepared, session: new FakeCliSession() });
          },
          execute: (_request, _session, _io, execution) => {
            executionSize = execution.head?.initialSize;
            return Promise.resolve(0);
          },
        }),
      ),
    ).toBe(0);
    expect(executionSize).toEqual({ cols: 117, rows: 39 });
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

  test("run-only dependencies lazy-load after routing", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-main-lazy-"));
    const prepared = mainHarness();
    expect(
      await main(["go"], prepared.context, {
        ...mainDependencies(),
        resolve: () =>
          Promise.resolve(resolvedRequest({ cwd: root, stateDir: join(root, "state") })),
        prepare: prepareDefaultCliSession,
      }),
    ).toBe(0);

    const executed = mainHarness();
    expect(
      await main(["go"], executed.context, {
        ...mainDependencies(),
        execute: executeDefaultCliRun,
      }),
    ).toBe(0);
    expect(executed.stdout.value).toBe("ok\n");
  });
});
