/**
 * Shared helpers for real adapter e2e tests: typed session observation, polling,
 * prompt readiness, and cleanup.
 * Implements PRD §12 and C-E2E-01 through C-E2E-04. Availability/skip logic lives in
 * `availability.ts`; scratch dirs and the Codex sandbox in `scratch.ts`; direct bridge
 * invocation in `bridge-helpers.ts`. All are re-exported here.
 */

import { existsSync } from "node:fs";
import type {
  ClaudeHookEvent,
  ClaudeSessionApi,
  CodexHookEvent,
  CodexSessionApi,
  CodexTranscriptEvent,
  ElwoodActivityEvent,
  ElwoodCommonEventMap,
  ElwoodWarningEvent,
  HookErrorEvent,
  Unsubscribe,
} from "../../src/index.ts";
import { type AgentName, e2eTimeoutMs } from "./availability.ts";

export {
  type AgentName,
  e2eTimeoutMs,
  requireAll,
  skipIf,
  skipNow,
  skipReason,
  skipTurns,
  turnsEnabled,
} from "./availability.ts";
export { invokeHookBridge, parseJsonOutput } from "./bridge-helpers.ts";
export {
  type CodexSandbox,
  codexAuthMissing,
  codexAuthPath,
  type E2eProject,
  makeProject,
  sandboxedCodexHome,
} from "./scratch.ts";

export type E2eSession = ClaudeSessionApi | CodexSessionApi;
export type HookEvent = ClaudeHookEvent | CodexHookEvent;

// The suite emulates an agent launched from the user's own terminal. When the
// suite itself runs nested inside a Claude Code session, claude >= 2.1.201
// skips conversation persistence for the nested instance (no projects/*.jsonl
// is written), which silently breaks every resume flow. Strip the nesting
// markers so spawned agents behave exactly as they would for a real user.
for (const key of Object.keys(process.env)) {
  if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) delete process.env[key];
}

/** The events `observeSession` records, with the payload each adapter emits. */
type ObservedEvents = Pick<
  ElwoodCommonEventMap,
  "terminal:data" | "status" | "activity" | "warning" | "hookError"
> & {
  readonly hook: HookEvent;
  readonly "codex:transcript": CodexTranscriptEvent;
};

// Both session APIs expose `on` as a generic method over their own event map; a union
// of two generic signatures is not callable, so subscribe through this per-event view.
// It is the only place the e2e suite widens a session type.
type EventSource = {
  on<E extends keyof ObservedEvents>(
    event: E,
    handler: (event: ObservedEvents[E]) => void,
  ): Unsubscribe;
};

export type ObservedSession = {
  readonly terminal: string[];
  readonly statuses: ElwoodCommonEventMap["status"][];
  readonly activities: ElwoodActivityEvent[];
  readonly hooks: HookEvent[];
  readonly warnings: ElwoodWarningEvent[];
  readonly hookErrors: HookErrorEvent[];
  readonly transcripts: CodexTranscriptEvent[];
  dispose(): void;
};

export function observeSession(session: E2eSession): ObservedSession {
  const source = session as unknown as EventSource;
  const observed = {
    terminal: [] as string[],
    statuses: [] as ElwoodCommonEventMap["status"][],
    activities: [] as ElwoodActivityEvent[],
    hooks: [] as HookEvent[],
    warnings: [] as ElwoodWarningEvent[],
    hookErrors: [] as HookErrorEvent[],
    transcripts: [] as CodexTranscriptEvent[],
  };
  const unsubscribers = [
    source.on("terminal:data", (event) => observed.terminal.push(event.data)),
    source.on("status", (event) => observed.statuses.push(event)),
    source.on("activity", (event) => observed.activities.push(event)),
    source.on("hook", (event) => observed.hooks.push(event)),
    source.on("warning", (event) => observed.warnings.push(event)),
    source.on("hookError", (event) => observed.hookErrors.push(event)),
    source.on("codex:transcript", (event) => observed.transcripts.push(event)),
  ];
  return {
    ...observed,
    dispose: () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  };
}

export async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  label: string,
  timeoutMs = e2eTimeoutMs,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function prepareInteractivePrompt(
  session: E2eSession,
  observed: ObservedSession,
  agent: AgentName,
): Promise<void> {
  await waitFor(
    () => (observed.terminal.join("").length > 0 ? true : undefined),
    `${agent} PTY data`,
    45_000,
  );
  await waitFor(() => {
    const text = session.terminal.snapshot().text;
    return promptReady(text, agent) ? true : undefined;
  }, `${agent} interactive prompt`);
}

export function hookNamed(events: readonly HookEvent[], name: string): HookEvent | undefined {
  return events.find((event) => event.hook_event_name === name);
}

export function hasActivity(events: readonly ElwoodActivityEvent[]): boolean {
  return events.length > 0;
}

export async function cleanup(session: E2eSession | undefined): Promise<void> {
  if (!session) return;
  try {
    await session.teardown();
  } catch {
    try {
      await session.kill();
    } catch {
      // Best effort cleanup after a failed real-agent test.
    }
  }
}

export function pathRemoved(path: string): boolean {
  return !existsSync(path);
}

function promptReady(text: string, agent: AgentName): boolean {
  if (/Press enter to continue/i.test(text)) return false;
  if (agent === "claude")
    return /bypass permissions|tokens|Claude Code/i.test(text) && /❯|>/.test(text);
  return /gpt-|tokens|codex/i.test(text) && /›|>/.test(text);
}
