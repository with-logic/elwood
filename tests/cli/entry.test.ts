/**
 * Real-process adaptation tests for stdin, environment, cwd, home, signals, and status.
 * Covers PRD §12A and C-CLI-01/C-CLI-07.
 */

import { describe, expect, test, vi } from "vitest";
import { type CliProcess, runCli } from "../../src/cli/entry.ts";
import type { RequestContext } from "../../src/cli/types.ts";
import { effectiveRequest, mainDependencies, resolvedRequest } from "./main-fakes.ts";
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
    let resolvedContext: RequestContext | undefined;
    let listenersDuringExecution: number | undefined;
    const dependencies = mainDependencies({
      resolve: (_parsed, context) => {
        resolvedContext = context;
        return Promise.resolve(resolvedRequest());
      },
      prepare: () =>
        Promise.resolve({
          request: mainDependenciesRequest(),
          session: new FakeCliSession(),
        }),
      execute: (_request, _session, _io, execution) => {
        const remove = execution.signals.onSigint(handler);
        listenersDuringExecution = listeners.size;
        listeners.values().next().value?.();
        remove();
        return Promise.resolve(130);
      },
    });
    await expect(runCli(proc, dependencies, "/home/cli")).resolves.toBe(130);
    expect(resolvedContext).toMatchObject({ invocationCwd: "/workspace", homeDir: "/home/cli" });
    expect(resolvedContext?.stdin.isTTY).toBeUndefined();
    expect(listenersDuringExecution).toBe(1);
    expect(proc.exitCode).toBe(130);
    expect(handler).toHaveBeenCalledOnce();
    expect(listeners).toHaveLength(0);
  });
});

test("C-CLI-23 binds terminal stdout so interactive mode can require a TTY", async () => {
  const stdout = Object.assign(new MemoryWriter(), { isTTY: true });
  const proc: CliProcess = {
    argv: ["node", "entry", "interactive"],
    stdout,
    stderr: new MemoryWriter(),
    stdin: { isTTY: true, async *[Symbol.asyncIterator]() {} },
    env: {},
    cwd: () => "/workspace",
    on: () => undefined,
    off: () => undefined,
    exitCode: undefined,
  };
  let seen: boolean | undefined;
  const dependencies = mainDependencies({
    interactive: (_parsed, context) => {
      seen = context.stdoutIsTTY;
      return Promise.resolve(0);
    },
  });
  await expect(runCli(proc, dependencies, "/home/cli")).resolves.toBe(0);
  expect(seen).toBe(true);
});

function mainDependenciesRequest() {
  return effectiveRequest({ cwd: "/workspace" });
}
