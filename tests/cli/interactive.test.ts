/**
 * Interactive-mode TTY gating, resume lookup, and SIGINT hand-off.
 * Covers PRD §12A.9 and C-CLI-25.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseCliArgs } from "../../src/cli/args/index.ts";
import type { ParsedInteractiveCommand } from "../../src/cli/command-types.ts";
import { runInteractiveCommand } from "../../src/cli/interactive/index.ts";
import type { InteractiveLaunch } from "../../src/cli/interactive/spawn.ts";
import { createSessionRecord, updateSessionResumeId } from "../../src/state/store.ts";
import { FakeSignals } from "./run-fakes.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function parsed(argv: readonly string[]): ParsedInteractiveCommand {
  const command = parseCliArgs(["interactive", ...argv]);
  if (command.command !== "interactive") throw new Error("expected interactive");
  return command;
}

async function* emptyStdin(): AsyncGenerator<string> {}

describe("runInteractiveCommand", () => {
  test("C-CLI-25 requires terminal stdin and stdout before resolving anything", async () => {
    const signals = new FakeSignals();
    const base = { env: {}, invocationCwd: tmpdir(), homeDir: tmpdir(), signals };
    const dependencies = {
      readRecord: () => {
        throw new Error("must not read");
      },
      finalize: () => Promise.reject(new Error("must not finalize")),
      spawn: () => Promise.reject(new Error("must not spawn")),
    };
    await expect(
      runInteractiveCommand(
        parsed([]),
        { ...base, stdin: { isTTY: false, source: emptyStdin() }, stdoutIsTTY: true },
        dependencies,
      ),
    ).rejects.toThrow("interactive requires terminal stdin and stdout.");
    await expect(
      runInteractiveCommand(
        parsed([]),
        { ...base, stdin: { isTTY: true, source: emptyStdin() } },
        dependencies,
      ),
    ).rejects.toThrow("interactive requires terminal stdin and stdout.");
  });

  test("C-CLI-25 spawns the resolved launch with SIGINT ignored, then releases the handler", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-interactive-"));
    roots.push(root);
    const signals = new FakeSignals();
    const launches: InteractiveLaunch[] = [];
    const context = {
      env: {},
      invocationCwd: root,
      homeDir: join(root, "home"),
      stdin: { isTTY: true, source: emptyStdin() },
      stdoutIsTTY: true,
      signals,
    };
    const status = await runInteractiveCommand(
      parsed(["--agent", "claude", "--claude-permission-mode", "plan", "--model", "opus"]),
      context,
      {
        readRecord: () => {
          throw new Error("must not read");
        },
        finalize: (draft, stored) => {
          expect(stored).toBeUndefined();
          return import("../../src/cli/request/index.ts").then((m) => m.finalizeRunRequest(draft));
        },
        spawn: (launch) => {
          expect(signals.handler).toBeDefined();
          signals.emit(); // Ctrl-C reaches the agent; Elwood's handler deliberately does nothing.
          launches.push(launch);
          return Promise.resolve(7);
        },
      },
    );
    expect(status).toBe(7);
    expect(launches).toEqual([
      {
        agent: "claude",
        command: "claude",
        args: ["--model", "opus", "--permission-mode", "plan"],
        cwd: root,
      },
    ]);
    expect(signals.unbound).toBe(true);
    expect(signals.handler).toBeUndefined();
  });

  test("C-CLI-25 an id loads the stored record with resume semantics", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-interactive-"));
    roots.push(root);
    const stored = updateSessionResumeId(
      createSessionRecord({ cwd: root, id: "abc", adapter: "codex" }),
      "codex",
      "thread-2",
    );
    const reads: string[][] = [];
    const context = {
      env: {},
      invocationCwd: tmpdir(),
      homeDir: join(root, "home"),
      stdin: { isTTY: true, source: emptyStdin() },
      stdoutIsTTY: true,
      signals: new FakeSignals(),
    };
    const status = await runInteractiveCommand(parsed(["abc", "--state-dir", root]), context, {
      readRecord: (stateDir, id) => {
        reads.push([stateDir, id]);
        return stored;
      },
      finalize: (draft, storedInput) =>
        import("../../src/cli/request/index.ts").then((m) =>
          m.finalizeRunRequest(draft, storedInput),
        ),
      spawn: (launch) => {
        expect(launch).toEqual({
          agent: "codex",
          command: "codex",
          args: ["resume", "thread-2", "--cd", root],
          cwd: root,
        });
        return Promise.resolve(0);
      },
    });
    expect(status).toBe(0);
    expect(reads).toEqual([[root, "abc"]]);
    await expect(
      runInteractiveCommand(parsed(["abc", "--state-dir", root, "--agent", "claude"]), context, {
        readRecord: () => stored,
        finalize: (draft, storedInput) =>
          import("../../src/cli/request/index.ts").then((m) =>
            m.finalizeRunRequest(draft, storedInput),
          ),
        spawn: () => Promise.reject(new Error("must not spawn")),
      }),
    ).rejects.toThrow("--agent is incompatible with the stored Codex session.");
  });
});
