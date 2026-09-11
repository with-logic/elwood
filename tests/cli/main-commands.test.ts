/**
 * Routing for the sessions, interactive, and models commands through the CLI main.
 * Covers PRD §12A.7-§12A.10 and C-CLI-21 through C-CLI-24.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { executeDefaultModels, main, runDefaultInteractive } from "../../src/cli/main.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import type { ParsedRunCommand } from "../../src/cli/types.ts";
import {
  effectiveRequest,
  fakeResolution,
  mainDependencies,
  mainHarness,
  resolvedRequest,
} from "./main-fakes.ts";
import { FakeCliSession, FakeSignals, MemoryWriter } from "./run-fakes.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CLI command routing", () => {
  test("C-CLI-21 resume <id> resolves through the run path with the rewritten flags", async () => {
    const seen: ParsedRunCommand[] = [];
    const dependencies = mainDependencies({
      resolve: (parsed) => {
        seen.push(parsed);
        return Promise.resolve(resolvedRequest({ resume: "abc" }));
      },
    });
    const h = mainHarness();
    expect(await main(["resume", "abc", "hello"], h.context, dependencies)).toBe(0);
    expect(seen[0]).toMatchObject({ flags: { resume: "abc" }, promptWords: ["hello"] });
  });

  test("C-CLI-22 sessions lists real state without resolving or preparing a run", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-main-sessions-"));
    roots.push(root);
    const dependencies = mainDependencies({
      resolve: () => Promise.reject(new Error("must not resolve")),
      prepare: () => Promise.reject(new Error("must not prepare")),
    });
    const h = mainHarness();
    const stateDir = join(root, "state");
    expect(
      await main(
        ["sessions", "--state-dir", stateDir, "--output", "json"],
        h.context,
        dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(h.stdout.value)).toEqual({
      schemaVersion: 1,
      type: "sessions",
      stateDir,
      sessions: [],
    });
    const rejected = mainHarness();
    expect(await main(["sessions", "--keep"], rejected.context, dependencies)).toBe(2);
    expect(rejected.stderr.value).toBe("elwood: --keep cannot be combined with sessions.\n");
  });

  test("C-CLI-23 interactive delegates the parsed command and context, mapping failures", async () => {
    const h = mainHarness();
    let received: unknown;
    const dependencies = mainDependencies({
      interactive: (parsed, context) => {
        received = { parsed, context };
        return Promise.resolve(5);
      },
    });
    expect(await main(["interactive", "abc", "--agent", "codex"], h.context, dependencies)).toBe(5);
    expect(received).toMatchObject({
      parsed: {
        command: "interactive",
        id: "abc",
        run: { flags: { agent: "codex", resume: "abc" } },
      },
      context: { invocationCwd: "/work" },
    });
    const notTerminal = mainHarness();
    expect(
      await main(
        ["interactive"],
        notTerminal.context,
        mainDependencies({ interactive: runDefaultInteractive }),
      ),
    ).toBe(2);
    expect(notTerminal.stderr.value).toBe(
      "elwood: interactive requires terminal stdin and stdout.\n",
    );
  });

  test("C-CLI-24 models resolves settings, prepares a session, and runs the listing executor", async () => {
    const h = mainHarness();
    const session = new FakeCliSession();
    const calls: string[] = [];
    const dependencies = mainDependencies({
      settings: (parsed) => {
        calls.push(`settings:${parsed.flags.agent}`);
        return Promise.resolve(resolvedRequest({ agent: "claude" }));
      },
      prepare: (draft) => {
        calls.push(`prepare:${draft.agent}`);
        return Promise.resolve({ request: effectiveRequest({ agent: "claude" }), session });
      },
      listModels: (request, prepared, _io, execution) => {
        calls.push(`list:${request.agent}:${prepared === session}:${typeof execution.signals}`);
        return Promise.resolve(0);
      },
    });
    expect(await main(["models", "--agent", "claude"], h.context, dependencies)).toBe(0);
    expect(calls).toEqual(["settings:claude", "prepare:claude", "list:claude:true:object"]);
  });

  test("C-CLI-24 models rejects JSONL and reports a failed preparation in the selected protocol", async () => {
    const jsonl = mainHarness();
    const dependencies = mainDependencies({
      settings: () =>
        Promise.resolve(
          resolvedRequest({ output: "jsonl", resolution: fakeResolution({ output: "--output" }) }),
        ),
    });
    expect(await main(["models", "--output", "jsonl"], jsonl.context, dependencies)).toBe(2);
    expect(jsonl.stdout.value).toContain('"code":"invalid_arguments"');

    const failed = mainHarness();
    expect(
      await main(
        ["models", "--output", "json"],
        failed.context,
        mainDependencies({
          settings: () => Promise.resolve(resolvedRequest({ output: "json", agent: "claude" })),
          prepare: () => Promise.reject(new Error("boom")),
        }),
      ),
    ).toBe(1);
    expect(JSON.parse(failed.stdout.value)).toMatchObject({
      type: "error",
      agent: "claude",
      error: { code: "runtime_error" },
    });
  });

  test("C-CLI-24 the default models executor loads the real implementation", async () => {
    const session = new FakeCliSession();
    session.underlying.listModels = () => Promise.resolve([]);
    const stdout = new MemoryWriter();
    const status = await executeDefaultModels(
      effectiveRequest({ prompt: "" }),
      session,
      { stdout: new AsyncOutputSink(stdout), stderr: new AsyncOutputSink(stdout) },
      { signals: new FakeSignals() },
    );
    expect(status).toBe(0);
    expect(stdout.value).toBe("CURRENT  ID  LABEL  DEFAULT  DESCRIPTION\n");
  });
});
