/**
 * Real-process adaptation tests for stdin, environment, cwd, home, signals, and status.
 * Covers PRD §12A and C-CLI-01/C-CLI-07.
 */

import { describe, expect, test, vi } from "vitest";
import { type CliProcess, runCli } from "../../src/cli/entry.ts";
import { mainDependencies, resolvedRequest } from "./main-fakes.ts";
import { FakeCliSession, MemoryWriter } from "./run-fakes.ts";

describe("CLI process adapter", () => {
  test("C-CLI-01 binds process context and removes injected SIGINT listeners", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const listeners = new Set<() => void>();
    const stdin = {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        await Promise.resolve();
        yield Buffer.from("context");
      },
    };
    const proc: CliProcess = {
      argv: ["node", "entry", "go"],
      stdout,
      stderr,
      stdin,
      env: { ELWOOD_AGENT: "codex" },
      cwd: () => "/workspace",
      on: (_event, handler) => listeners.add(handler),
      off: (_event, handler) => listeners.delete(handler),
      exitCode: undefined,
    };
    const handler = vi.fn();
    const dependencies = mainDependencies({
      resolve: (_parsed, context) => {
        expect(context).toMatchObject({ invocationCwd: "/workspace", homeDir: "/home/cli" });
        expect(context.stdin.isTTY).toBeUndefined();
        return Promise.resolve(resolvedRequest());
      },
      prepare: () =>
        Promise.resolve({
          request: mainDependenciesRequest(),
          session: new FakeCliSession(),
        }),
      execute: (_request, _session, _io, execution) => {
        const remove = execution.signals.onSigint(handler);
        expect(listeners).toHaveLength(1);
        listeners.values().next().value?.();
        remove();
        return Promise.resolve(130);
      },
    });
    await expect(runCli(proc, dependencies, "/home/cli")).resolves.toBe(130);
    expect(proc.exitCode).toBe(130);
    expect(handler).toHaveBeenCalledOnce();
    expect(listeners).toHaveLength(0);
  });
});

function mainDependenciesRequest() {
  return {
    agent: "codex" as const,
    output: "text" as const,
    outputExplicit: false,
    trust: true,
    stateDir: "/state",
    verbose: false,
    stream: false,
    cwd: "/workspace",
    images: [],
    prompt: "go",
    keep: false,
    ephemeral: false,
    sandbox: "workspace-write" as const,
    approvalPolicy: "never" as const,
  };
}
