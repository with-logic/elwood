/**
 * Minimal runnable Elwood example for starting one agent session, sending one
 * message, and observing the unified activity stream.
 */

import { resolve } from "node:path";
import {
  type ElwoodActivityEvent,
  type ElwoodSessionStatus,
  type ElwoodWarningEvent,
  type HookErrorEvent,
  startClaude,
  startCodex,
  type Unsubscribe,
} from "../src/index.ts";

type Agent = "claude" | "codex";
type Options = {
  readonly agent: Agent;
  readonly cwd: string;
  readonly keep: boolean;
  readonly prompt: string;
  readonly timeoutMs: number;
};
type StatusEvent = { readonly status: ElwoodSessionStatus };
type TerminalExitEvent = { readonly exitCode: number; readonly signal?: number };
type SharedSession = {
  readonly elwoodSessionId: string;
  readonly status: ElwoodSessionStatus;
  on(event: "activity", handler: (event: ElwoodActivityEvent) => void): Unsubscribe;
  on(event: "warning", handler: (event: ElwoodWarningEvent) => void): Unsubscribe;
  on(event: "hookError", handler: (event: HookErrorEvent) => void): Unsubscribe;
  on(event: "status", handler: (event: StatusEvent) => void): Unsubscribe;
  on(event: "terminal:exit", handler: (event: TerminalExitEvent) => void): Unsubscribe;
  sendMessage(message: string): Promise<void>;
  stop(): Promise<void>;
  kill(): Promise<void>;
};

const options = parseArgs(process.argv.slice(2));
let session: SharedSession | undefined;

try {
  session = await startSession(options);
  wireLogs(session);
  process.stdout.write(`started ${options.agent} session ${session.elwoodSessionId}\n`);
  await session.sendMessage(options.prompt);
  await waitForSettled(session, options.timeoutMs);
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
} finally {
  if (session && !options.keep && !isTerminalStatus(session.status)) {
    await stopSession(session);
  }
}

async function startSession(options: Options): Promise<SharedSession> {
  const common = {
    cwd: options.cwd,
    autotrust: true,
    initialSize: { cols: 120, rows: 40 },
  };
  return options.agent === "claude" ? await startClaude(common) : await startCodex(common);
}

function wireLogs(session: SharedSession): void {
  session.on("activity", (event) => {
    process.stdout.write(
      `[activity] ${event.agent}:${event.kind}:${event.label}${textSuffix(event.text)}\n`,
    );
  });
  session.on("warning", (event) => {
    process.stdout.write(`[warning] ${event.agent}:${event.code} ${event.message}\n`);
  });
  session.on("hookError", (event) => {
    process.stdout.write(`[hookError] ${event.hookEventName}:${event.category} ${event.message}\n`);
  });
  session.on("terminal:exit", (event) => {
    process.stdout.write(
      `[terminal:exit] code=${event.exitCode} signal=${event.signal ?? "none"}\n`,
    );
  });
}

function waitForSettled(session: SharedSession, timeoutMs: number): Promise<void> {
  if (session.status === "ready" || isTerminalStatus(session.status)) return Promise.resolve();
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolve, timeoutMs);
    const unsubs: Unsubscribe[] = [
      session.on("status", (event) => {
        if (event.status === "ready" || isTerminalStatus(event.status)) resolve();
      }),
      session.on("terminal:exit", () => resolve()),
    ];
    function resolve(): void {
      clearTimeout(timer);
      for (const unsubscribe of unsubs) unsubscribe();
      resolveWait();
    }
  });
}

async function stopSession(session: SharedSession): Promise<void> {
  try {
    await session.stop();
  } catch (error) {
    process.stderr.write(`stop failed, killing session: ${errorMessage(error)}\n`);
    await session.kill();
  }
}

function parseArgs(args: readonly string[]): Options {
  let agent: Agent = "codex";
  let cwd = process.cwd();
  let keep = false;
  let prompt = "";
  let timeoutMs = 120_000;
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "--help") return printUsageAndExit();
    if (arg === "--agent") {
      agent = parseAgent(requireValue(args, index + 1, "--agent"));
      index += 2;
      continue;
    }
    if (arg === "--cwd") {
      cwd = resolve(requireValue(args, index + 1, "--cwd"));
      index += 2;
      continue;
    }
    if (arg === "--prompt") {
      prompt = requireValue(args, index + 1, "--prompt");
      index += 2;
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = Number(requireValue(args, index + 1, arg));
      index += 2;
      continue;
    }
    if (arg === "--keep") {
      keep = true;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (!prompt) throw new Error("Missing required --prompt. Run with --help for usage.");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("--timeout-ms must be positive.");
  return { agent, cwd: resolve(cwd), keep, prompt, timeoutMs };
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`Missing value for ${flag}.`);
  return value;
}

function parseAgent(value: string): Agent {
  if (value === "claude" || value === "codex") return value;
  throw new Error("--agent must be claude or codex.");
}

function printUsageAndExit(): never {
  process.stdout.write(
    'Usage: bun examples/minimal.ts --agent codex --cwd . --prompt "Summarize this repo."\n',
  );
  process.exit(0);
}

function isTerminalStatus(status: ElwoodSessionStatus): boolean {
  return (
    status === "stopped" || status === "exited" || status === "killed" || status === "torn_down"
  );
}

function textSuffix(text: string | undefined): string {
  if (!text) return "";
  const compact = text.replace(/\s+/g, " ").slice(0, 120);
  return ` ${compact}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
