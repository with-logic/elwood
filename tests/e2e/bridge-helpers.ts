/**
 * Direct hook-bridge invocation plus the assertions and payload builders the hook
 * bridge e2e tests share. Implements PRD §12 and C-E2E-01.
 */

import { spawn } from "node:child_process";
import type { HookErrorEvent } from "../../src/index.ts";
import { onlyLaunchArtifact } from "../helpers/launch-artifacts.ts";
import type { E2eProject } from "./scratch.ts";

export type JsonObject = Readonly<Record<string, unknown>>;

export async function invokeHookBridge(
  project: E2eProject,
  elwoodSessionId: string,
  input: Readonly<Record<string, unknown>>,
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  const bridgePath = onlyLaunchArtifact(project.sessionDir(elwoodSessionId), "hook-bridge");
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
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
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

export function assertJson(stdout: string, path: readonly string[], expected: unknown): void {
  let value: unknown = parseJsonOutput<JsonObject>(stdout);
  for (const segment of path) value = (value as JsonObject)[segment];
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)} at ${path.join(".")}, got ${JSON.stringify(value)}`,
    );
  }
}

export function claudeToolEvent(base: JsonObject, hook_event_name: string): JsonObject {
  return { ...base, hook_event_name, tool_name: "Bash", tool_input: { command: "echo ok" } };
}

export function claudePostToolEvent(base: JsonObject): JsonObject {
  return { ...claudeToolEvent(base, "PostToolUse"), tool_response: { output: "ok" } };
}

export function codexToolEvent(
  base: JsonObject,
  hook_event_name: string,
  command: string,
): JsonObject {
  return { ...base, hook_event_name, tool_name: "Bash", tool_input: { command } };
}

export function commandFromToolInput(input: unknown): string {
  if (!input || typeof input !== "object" || !("command" in input)) return "";
  const command = (input as { readonly command?: unknown }).command;
  return typeof command === "string" ? command : "";
}

export function hasHookError(events: readonly HookErrorEvent[], hookEventName: string): boolean {
  return events.some((event) => event.hookEventName === hookEventName);
}
