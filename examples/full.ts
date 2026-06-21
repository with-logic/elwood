/**
 * Full runnable Elwood example for starting one agent session, sending one
 * message, logging rich events, and cleaning up the process.
 */

import { resolve } from "node:path";
import { startClaude, startCodex } from "../src/index.ts";
import {
  type Agent,
  cleanupSession,
  type ExampleSession,
  errorMessage,
  isTerminalStatus,
  textSuffix,
  waitForSettled,
} from "./support.ts";

type Options = {
  readonly agent: Agent;
  readonly cwd: string;
  readonly keep: boolean;
  readonly prompt: string;
  readonly timeoutMs: number;
};

const options = parseArgs(process.argv.slice(2));
let session: ExampleSession | undefined;

try {
  session = await startSession(options);
  wireLogs(session);
  process.stdout.write(`started ${options.agent} session ${session.elwoodSessionId}\n`);
  await session.sendMessage(options.prompt);
  if (!(await waitForSettled(session, options.timeoutMs))) {
    throw new Error(`Timed out after ${options.timeoutMs}ms waiting for the agent to finish.`);
  }
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
} finally {
  if (session && !options.keep && !isTerminalStatus(session.status)) await cleanupSession(session);
}

async function startSession(options: Options): Promise<ExampleSession> {
  const common = { cwd: options.cwd, autotrust: true, initialSize: { cols: 120, rows: 40 } };
  return options.agent === "claude" ? await startClaude(common) : await startCodex(common);
}

function wireLogs(session: ExampleSession): void {
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
    process.stdout.write(`[terminal:exit] code=${event.exitCode}\n`);
  });
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
    if (arg === "--agent")
      [agent, index] = [parseAgent(requireValue(args, index + 1, arg)), index + 2];
    else if (arg === "--cwd")
      [cwd, index] = [resolve(requireValue(args, index + 1, arg)), index + 2];
    else if (arg === "--prompt") [prompt, index] = [requireValue(args, index + 1, arg), index + 2];
    else if (arg === "--timeout-ms")
      [timeoutMs, index] = [Number(requireValue(args, index + 1, arg)), index + 2];
    else if (arg === "--keep") [keep, index] = [true, index + 1];
    else throw new Error(`Unknown option: ${arg}`);
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
    'Usage: bun run example:full -- --agent codex --cwd . --prompt "Summarize this repo."\n',
  );
  process.exit(0);
}
