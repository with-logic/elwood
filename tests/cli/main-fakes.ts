/**
 * Shared side-effect-free command contexts and dependencies for CLI routing tests.
 */

import type { CliHeadTarget } from "../../src/cli/head/types.ts";
import type { CliMainContext, CliMainDependencies } from "../../src/cli/main.ts";
import type {
  CliAgent,
  CliRequestResolution,
  EffectiveRunRequest,
  ResolvedRunRequest,
} from "../../src/cli/types.ts";
import type {
  ClaudeReasoningEffort,
  CodexReasoningEffort,
} from "../../src/core/reasoning-effort.ts";
import type { TerminalSize } from "../../src/core/types.ts";
import { FakeCliSession, FakeSignals, MemoryWriter } from "./run-fakes.ts";

export const resolvedRequest = (
  overrides: Partial<ResolvedRunRequest> = {},
): ResolvedRunRequest => ({
  agent: "codex",
  output: "text",
  outputExplicit: false,
  trust: true,
  highTrust: false,
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

/** Overrides accept either adapter; the fixture does not re-narrow effort per adapter. */
export type EffectiveRequestOverrides = Partial<
  Omit<EffectiveRunRequest, "agent" | "reasoningEffort">
> & {
  readonly agent?: CliAgent;
  readonly reasoningEffort?: ClaudeReasoningEffort | CodexReasoningEffort;
};

/**
 * A text-mode request with every required field and the built-in posture for
 * the (default Codex) adapter. The cast is needed because a spread over the
 * agent-effort union does not re-narrow, though every caller passes one
 * adapter's values.
 */
export const effectiveRequest = (overrides: EffectiveRequestOverrides = {}): EffectiveRunRequest =>
  ({
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
    ...(overrides.agent === "claude"
      ? { permissionMode: "dontAsk" }
      : { sandbox: "workspace-write", approvalPolicy: "never" }),
    ...overrides,
  }) as EffectiveRunRequest;

/** Provenance with every source built-in/unset unless overridden, for posture-aware tests. */
export function fakeResolution(
  sources: Partial<CliRequestResolution["sources"]> = {},
): CliRequestResolution {
  return {
    config: { path: "/cfg", source: "home directory", loaded: false },
    sources: {
      agent: "built-in",
      output: "built-in",
      timeoutMs: "built-in",
      trust: "built-in",
      highTrust: "built-in",
      stateDir: "built-in",
      verbose: "built-in",
      stream: "built-in",
      debug: "built-in",
      head: "built-in",
      persona: "unset",
      model: "unset",
      reasoningEffort: "unset",
      permissionMode: "built-in",
      sandbox: "built-in",
      approvalPolicy: "built-in",
      workspace: "invocation cwd",
      ...sources,
    },
    agentOptionSources: {
      claude: { model: "unset", reasoningEffort: "unset" },
      codex: { model: "unset", reasoningEffort: "unset" },
    },
  };
}

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
    settings: () => Promise.resolve(resolvedRequest()),
    prepare: () => Promise.resolve({ request: effective, session: new FakeCliSession() }),
    execute: () => Promise.resolve(0),
    listModels: () => Promise.resolve(0),
    interactive: () => Promise.resolve(0),
    now: () => 10,
    ...overrides,
  };
}

async function* emptyInput(): AsyncGenerator<string> {}
