/**
 * Shared helpers for real adapter e2e tests.
 * Implements PRD §12 and C-E2E-01 through C-E2E-04.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeSession, CodexSession } from "../../src/index.ts";

export type AgentName = "claude" | "codex";
export type E2eSession = ClaudeSession | CodexSession;

type EventSource = {
  on(event: string, handler: (event: unknown) => void): () => void;
};

export type ObservedSession = {
  readonly terminal: string[];
  readonly statuses: unknown[];
  readonly activities: unknown[];
  readonly hooks: unknown[];
  readonly warnings: unknown[];
  readonly hookErrors: unknown[];
  readonly transcripts: unknown[];
  dispose(): void;
};

export const e2eTimeoutMs = Number(process.env["ELWOOD_E2E_TIMEOUT_MS"] ?? 180_000);
export const turnsEnabled = process.env["ELWOOD_E2E_SKIP_TURNS"] !== "1";

export function skipReason(agent: AgentName): string | false {
  const envKey = `ELWOOD_E2E_SKIP_${agent.toUpperCase()}`;
  if (process.env[envKey] === "1") return `${envKey}=1`;
  const result = spawnSync("/bin/zsh", ["-l", "-i", "-c", `${agent} --version >/dev/null`], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.status === 0) return false;
  return `${agent} CLI is not available from an interactive login shell`;
}

export function makeProject(agent: AgentName) {
  const root = mkdtempSync(join(tmpdir(), `elwood-e2e-${agent}-`));
  writeFileSync(join(root, "AGENTS.md"), "Answer directly. Do not modify files unless asked.\n");
  return {
    cwd: root,
    stateDir: join(root, ".state"),
    sessionDir: (id: string) => join(root, ".state", "sessions", id),
  };
}

export function observeSession(session: E2eSession): ObservedSession {
  const source = session as unknown as EventSource;
  const observed = {
    terminal: [] as string[],
    statuses: [] as unknown[],
    activities: [] as unknown[],
    hooks: [] as unknown[],
    warnings: [] as unknown[],
    hookErrors: [] as unknown[],
    transcripts: [] as unknown[],
  };
  const unsubscribers = [
    source.on("terminal:data", (event) => observed.terminal.push(field(event, "data"))),
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

export function hookNamed(events: readonly unknown[], name: string): unknown | undefined {
  return events.find((event) => field(event, "hook_event_name") === name);
}

export function hasActivity(events: readonly unknown[]): boolean {
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

export async function invokeHookBridge(
  project: ReturnType<typeof makeProject>,
  elwoodSessionId: string,
  input: Readonly<Record<string, unknown>>,
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  const bridgePath = join(project.sessionDir(elwoodSessionId), "hook-bridge.mjs");
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath], {
      env: { ...process.env, ELWOOD_SESSION_ID: elwoodSessionId },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out invoking hook bridge"));
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export function parseJsonOutput<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

function field(event: unknown, key: string): string {
  if (!event || typeof event !== "object" || !(key in event)) return "";
  const value = (event as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function promptReady(text: string, agent: AgentName): boolean {
  if (/Press enter to continue/i.test(text)) return false;
  if (agent === "claude")
    return /bypass permissions|tokens|Claude Code/i.test(text) && /❯|>/.test(text);
  return /gpt-|tokens|codex/i.test(text) && /›|>/.test(text);
}
