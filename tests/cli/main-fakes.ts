/**
 * Shared side-effect-free command contexts and dependencies for CLI routing tests.
 */

import type { CliHeadTarget } from "../../src/cli/head/types.ts";
import type { CliMainContext, CliMainDependencies } from "../../src/cli/main.ts";
import type { EffectiveRunRequest, ResolvedRunRequest } from "../../src/cli/types.ts";
import type { TerminalSize } from "../../src/core/types.ts";
import { FakeCliSession, FakeSignals, MemoryWriter } from "./run-fakes.ts";

export const resolvedRequest = (
  overrides: Partial<ResolvedRunRequest> = {},
): ResolvedRunRequest => ({
  agent: "codex",
  output: "text",
  outputExplicit: false,
  trust: true,
  stateDir: "/state",
  verbose: false,
  stream: false,
  cwd: "/work",
  imagePaths: [],
  prompt: "go",
  keep: false,
  ephemeral: false,
  sandbox: "workspace-write",
  approvalPolicy: "never",
  ...overrides,
});

export const effectiveRequest = (
  overrides: Partial<EffectiveRunRequest> = {},
): EffectiveRunRequest => ({
  agent: "codex",
  output: "text",
  outputExplicit: false,
  trust: true,
  stateDir: "/state",
  verbose: false,
  stream: false,
  cwd: "/work",
  images: [],
  prompt: "go",
  keep: false,
  ephemeral: false,
  sandbox: "workspace-write",
  approvalPolicy: "never",
  ...overrides,
});

export function mainHarness() {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const context: CliMainContext = {
    stdout,
    stderr,
    stdin: { isTTY: true, source: emptyInput() },
    env: {},
    invocationCwd: "/work",
    homeDir: "/home/test",
    signals: new FakeSignals(),
  };
  return {
    stdout,
    stderr,
    context,
    headTarget: (size: TerminalSize) => fakeHeadTarget(size),
  };
}

function fakeHeadTarget(initialSize: TerminalSize) {
  const output = new MemoryWriter();
  const target: CliHeadTarget = {
    output,
    size: () => initialSize,
    isRaw: () => false,
    setRawMode: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
    onInput: () => () => undefined,
    onResize: () => () => undefined,
  };
  return { output, target };
}

export function mainDependencies(
  overrides: Partial<CliMainDependencies> = {},
): CliMainDependencies {
  const effective = effectiveRequest();
  return {
    version: () => "9.8.7",
    resolve: () => Promise.resolve(resolvedRequest()),
    prepare: () => Promise.resolve({ request: effective, session: new FakeCliSession() }),
    execute: () => Promise.resolve(0),
    now: () => 10,
    ...overrides,
  };
}

async function* emptyInput(): AsyncGenerator<string> {}
