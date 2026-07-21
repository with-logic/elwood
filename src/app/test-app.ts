/**
 * Small local developer test app runner for observing live Elwood sessions.
 * Implements PRD §11.
 */

import type { TerminalSize } from "../index.ts";
import {
  type AgentKind,
  type AgentRuntime,
  createLiveHookHandlers,
  defaultAgentRuntime,
  parseAgentKind,
  type SharedSession,
  startAgentSession,
} from "./agent-runtime.ts";

export {
  createLiveHookHandlers,
  summarizeHookResult,
} from "./agent-runtime.ts";

export type TestAppArgs = {
  readonly agent: AgentKind;
  readonly cwd: string;
  readonly stateDir?: string;
  /** Elwood session id to resume (the public id), not an adapter `resumeId`. */
  readonly elwoodSessionId?: string;
  readonly size: TerminalSize;
};

export type TestAppIo = {
  readonly stdin: AsyncIterable<string | Uint8Array>;
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
};

export type TestAppRuntime = AgentRuntime;
export const defaultTestAppRuntime: TestAppRuntime = defaultAgentRuntime;

export async function runTestApp(
  argv: readonly string[],
  io: TestAppIo,
  runtime: TestAppRuntime = defaultTestAppRuntime,
): Promise<string> {
  const args = parseTestAppArgs(argv);
  const hooks = createLiveHookHandlers(args.agent, io.stderr);
  const session = await startAgentSession({ ...args, hooks }, runtime);
  wireSessionToTestApp(session, io);
  await pumpPrompts(session, io.stdin);
  return session.elwoodSessionId;
}

export function parseTestAppArgs(argv: readonly string[]): TestAppArgs {
  const agent = parseAgentKind(readOption(argv, "--agent"));
  const cwd = readOption(argv, "--cwd") ?? process.cwd();
  const stateDir = readOption(argv, "--state-dir");
  const elwoodSessionId = readOption(argv, "--resume");
  const size = parseSize(readOption(argv, "--size") ?? "189x48");
  return {
    agent,
    cwd,
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(elwoodSessionId === undefined ? {} : { elwoodSessionId }),
    size,
  };
}

function wireSessionToTestApp(session: SharedSession, io: TestAppIo): void {
  session.on("terminal:data", (event) => io.stdout.write(event.data));
  session.on("terminal:exit", (event) =>
    io.stderr.write(formatEventLog("terminal", "exit", String(event.exitCode))),
  );
  session.on("status", (event) => io.stderr.write(formatEventLog("status", event.status)));
  session.on("activity", (event) =>
    io.stderr.write(formatEventLog("activity", event.kind, event.label)),
  );
  session.on("warning", (event) => io.stderr.write(formatEventLog("warning", event.code)));
  session.on("hookError", (event) =>
    io.stderr.write(formatEventLog("hookError", event.hookEventName, event.category)),
  );
}

async function pumpPrompts(
  session: SharedSession,
  stdin: AsyncIterable<string | Uint8Array>,
): Promise<void> {
  for await (const chunk of stdin) {
    const input = normalizeInputChunk(chunk);
    const resize = parseResizeCommand(input);
    if (resize) {
      await session.resize(resize);
    } else {
      await session.sendPrompt(input);
    }
  }
}

function normalizeInputChunk(chunk: string | Uint8Array): string {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
}

function parseResizeCommand(input: string): TerminalSize | null {
  const match = /^\/resize\s+(\d+)x(\d+)\s*$/.exec(input);
  if (!match) return null;
  return { cols: Number(match[1]), rows: Number(match[2]) };
}

function parseSize(value: string): TerminalSize {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) return { cols: 189, rows: 48 };
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
