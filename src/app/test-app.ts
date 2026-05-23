/**
 * Small local developer test app runner for observing live Elwood sessions.
 * Implements PRD §11.
 */

import {
  type ClaudeHookEvent,
  type ClaudeHookHandlers,
  type ClaudeHookResult,
  type ClaudeSession,
  claudeHookEventNames,
  type ResumeClaudeOptions,
  resumeClaude,
  type StartClaudeOptions,
  startClaude,
  type TerminalSize,
} from "../index.ts";

export type TestAppArgs = {
  readonly cwd: string;
  readonly stateDir?: string;
  readonly resumeSessionId?: string;
  readonly size: TerminalSize;
};

export type TestAppIo = {
  readonly stdin: AsyncIterable<string>;
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
};

export type TestAppRuntime = {
  readonly startClaude: (options: StartClaudeOptions) => Promise<ClaudeSession>;
  readonly resumeClaude: (options: ResumeClaudeOptions) => Promise<ClaudeSession>;
};

export const defaultTestAppRuntime: TestAppRuntime = { startClaude, resumeClaude };

export async function runTestApp(
  argv: readonly string[],
  io: TestAppIo,
  runtime: TestAppRuntime = defaultTestAppRuntime,
): Promise<string> {
  const args = parseTestAppArgs(argv);
  const hooks = createLiveHookHandlers(io.stderr);
  const session =
    args.resumeSessionId === undefined
      ? await runtime.startClaude({
          cwd: args.cwd,
          ...(args.stateDir === undefined ? {} : { stateDir: args.stateDir }),
          initialSize: args.size,
          hooks,
        })
      : await runtime.resumeClaude({
          elwoodSessionId: args.resumeSessionId,
          cwd: args.cwd,
          ...(args.stateDir === undefined ? {} : { stateDir: args.stateDir }),
          initialSize: args.size,
          hooks,
        });
  wireSessionToTestApp(session, io);
  await pumpPrompts(session, io.stdin);
  return session.elwoodSessionId;
}

export function parseTestAppArgs(argv: readonly string[]): TestAppArgs {
  const cwd = readOption(argv, "--cwd") ?? process.cwd();
  const stateDir = readOption(argv, "--state-dir");
  const resumeSessionId = readOption(argv, "--resume");
  const size = parseSize(readOption(argv, "--size") ?? "120x40");
  return {
    cwd,
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    size,
  };
}

export function summarizeHookResult(result: ClaudeHookResult): string {
  if (result === undefined) return "no decision";
  if ("permissionDecision" in result) return result.permissionDecision;
  if ("behavior" in result) return result.behavior;
  if ("decision" in result) return result.decision;
  if ("additionalContext" in result) return "context";
  if ("action" in result) return result.action;
  if ("retry" in result) return "retry";
  if ("worktreePath" in result) return "worktree";
  return "no decision";
}

export function createLiveHookHandlers(log: { write(chunk: string): unknown }): ClaudeHookHandlers {
  const handler = (event: ClaudeHookEvent): ClaudeHookResult => {
    log.write(formatEventLog("hook", event.hook_event_name, "no decision"));
    return undefined;
  };
  const handlers: Partial<Record<(typeof claudeHookEventNames)[number], typeof handler>> = {};
  for (const name of claudeHookEventNames) {
    handlers[name] = handler;
  }
  return handlers as ClaudeHookHandlers;
}

function wireSessionToTestApp(session: ClaudeSession, io: TestAppIo): void {
  session.on("terminal:data", (event) => io.stdout.write(event.data));
  session.on("terminal:exit", (event) =>
    io.stderr.write(formatEventLog("terminal", "exit", String(event.exitCode))),
  );
  session.on("status", (event) => io.stderr.write(formatEventLog("status", event.status)));
  session.on("hookError", (event) =>
    io.stderr.write(formatEventLog("hookError", event.hookEventName, event.category)),
  );
}

async function pumpPrompts(session: ClaudeSession, stdin: AsyncIterable<string>): Promise<void> {
  for await (const chunk of stdin) {
    const resize = parseResizeCommand(chunk);
    if (resize) {
      await session.resize(resize);
    } else {
      await session.sendPrompt(chunk);
    }
  }
}

function parseResizeCommand(input: string): TerminalSize | null {
  const match = /^\/resize\s+(\d+)x(\d+)\s*$/.exec(input);
  if (!match) return null;
  return { cols: Number(match[1]), rows: Number(match[2]) };
}

function parseSize(value: string): TerminalSize {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) return { cols: 120, rows: 40 };
  return { cols: Number(match[1]), rows: Number(match[2]) };
}

function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function formatEventLog(kind: string, name: string, detail?: string): string {
  return `[${kind}] ${name}${detail === undefined ? "" : ` ${detail}`}\n`;
}
