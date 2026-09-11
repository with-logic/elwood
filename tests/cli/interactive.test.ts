/**
 * Interactive-mode TTY gating, resume lookup, SIGINT hand-off, and the foreground
 * spawner against real local processes.
 * Covers PRD §12A.9 and C-CLI-23.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseCliArgs } from "../../src/cli/args/index.ts";
import type { ParsedInteractiveCommand } from "../../src/cli/command-types.ts";
import { runInteractiveCommand } from "../../src/cli/interactive/index.ts";
import {
  exitStatus,
  type InteractiveLaunch,
  spawnInteractiveAgent,
} from "../../src/cli/interactive/spawn.ts";
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
  test("C-CLI-23 requires terminal stdin and stdout before resolving anything", async () => {
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

  test("C-CLI-23 spawns the resolved launch with SIGINT ignored, then releases the handler", async () => {
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

  test("C-CLI-23 an id loads the stored record with resume semantics", async () => {
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

describe("spawnInteractiveAgent", () => {
  test("C-CLI-23 returns the agent's own exit status from a real foreground process", async () => {
    const launch = (args: readonly string[]): InteractiveLaunch => ({
      agent: "codex",
      command: "/bin/sh",
      args,
      cwd: tmpdir(),
    });
    expect(await spawnInteractiveAgent(launch(["-c", "exit 3"]))).toBe(3);
    expect(await spawnInteractiveAgent(launch(["-c", "kill -TERM $$"]))).toBe(143);
  });

  test("C-CLI-23 a missing or unstartable command maps to the adapter's error codes", async () => {
    await expect(
      spawnInteractiveAgent({
        agent: "claude",
        command: join(tmpdir(), "no-such-elwood-agent"),
        args: [],
        cwd: tmpdir(),
      }),
    ).rejects.toMatchObject({ code: "claude_not_found" });
    const root = mkdtempSync(join(tmpdir(), "elwood-interactive-"));
    roots.push(root);
    const notExecutable = join(root, "agent.txt");
    writeFileSync(notExecutable, "not a program", { mode: 0o600 });
    await expect(
      spawnInteractiveAgent({ agent: "codex", command: notExecutable, args: [], cwd: root }),
    ).rejects.toMatchObject({ code: "codex_start_failed" });
  });

  test("C-CLI-23 exit status mapping covers signals without numbers", () => {
    expect(exitStatus(0, null)).toBe(0);
    expect(exitStatus(null, "SIGINT")).toBe(130);
    expect(exitStatus(null, null)).toBe(1);
  });
});
