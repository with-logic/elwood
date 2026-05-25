/**
 * Project-local Elwood session metadata persistence.
 * Implements PRD §8.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ElwoodError, elwoodError } from "../core/errors.ts";
import type { ElwoodSessionStatus, ElwoodWarningEvent, TerminalSize } from "../core/types.ts";

export type SessionRecord = {
  readonly schemaVersion: 1;
  readonly elwoodSessionId: string;
  readonly adapter: "claude" | "codex";
  readonly cwd: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly warnings: readonly ElwoodWarningEvent[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: ElwoodSessionStatus;
  readonly claude: { readonly resumeId?: string; readonly name?: string };
  readonly codex: { readonly resumeId?: string; readonly name?: string };
  readonly paths: {
    readonly sessionDir: string;
    readonly settingsPath: string;
    readonly bridgeScriptPath: string;
    readonly socketPath: string;
  };
  readonly terminalSize?: TerminalSize;
};

export function defaultStateDir(cwd: string): string {
  return join(resolve(cwd), ".elwood");
}

export function sessionDir(stateDir: string, id: string): string {
  return join(stateDir, "sessions", id);
}

export function createSessionRecord(input: {
  readonly stateDir: string;
  readonly cwd: string;
  readonly id: string;
  readonly adapter?: "claude" | "codex";
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly size?: TerminalSize;
  readonly name?: string;
}): SessionRecord {
  const dir = sessionDir(input.stateDir, input.id);
  const now = new Date().toISOString();
  const adapter = input.adapter ?? "claude";
  return {
    schemaVersion: 1,
    elwoodSessionId: input.id,
    adapter,
    cwd: resolve(input.cwd),
    metadata: input.metadata ?? {},
    warnings: [],
    createdAt: now,
    updatedAt: now,
    status: "starting",
    claude: adapter === "claude" && input.name !== undefined ? { name: input.name } : {},
    codex: adapter === "codex" && input.name !== undefined ? { name: input.name } : {},
    paths: {
      sessionDir: dir,
      settingsPath: join(dir, `${adapter}-settings.json`),
      bridgeScriptPath: join(dir, "hook-bridge.mjs"),
      socketPath: join(dir, "hook.sock"),
    },
    ...(input.size === undefined ? {} : { terminalSize: input.size }),
  };
}

export function prepareStateDir(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, ".gitignore"), "*\n", { flag: "w" });
  mkdirSync(join(stateDir, "sessions"), { recursive: true });
}

export function writeSessionRecord(record: SessionRecord): void {
  mkdirSync(record.paths.sessionDir, { recursive: true });
  const path = recordPath(record.paths.sessionDir);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readSessionRecord(stateDir: string, id: string): SessionRecord {
  const dir = sessionDir(stateDir, id);
  try {
    const parsed = JSON.parse(readFileSync(recordPath(dir), "utf8")) as SessionRecord;
    if (parsed.schemaVersion !== 1 || parsed.elwoodSessionId !== id) {
      throw elwoodError("state_corrupt", `Session state is invalid for ${id}`);
    }
    return { ...parsed, warnings: parsed.warnings ?? [] };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw elwoodError("state_not_found", `No Elwood session found for ${id}`);
    }
    if (error instanceof ElwoodError) throw error;
    throw elwoodError("state_corrupt", `Session state is corrupt for ${id}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function updateSessionStatus(
  record: SessionRecord,
  status: ElwoodSessionStatus,
): SessionRecord {
  return { ...record, status, updatedAt: new Date().toISOString() };
}

export function updateSessionResumeId(
  record: SessionRecord,
  adapter: "claude" | "codex",
  resumeId: string,
): SessionRecord {
  return {
    ...record,
    [adapter]: { ...record[adapter], resumeId },
    updatedAt: new Date().toISOString(),
  };
}

export function appendSessionWarning(
  record: SessionRecord,
  warning: ElwoodWarningEvent,
): SessionRecord {
  if (record.warnings.some((existing) => warningKey(existing) === warningKey(warning)))
    return record;
  return {
    ...record,
    warnings: [...record.warnings, warning],
    updatedAt: new Date().toISOString(),
  };
}

export function removeSessionDir(record: SessionRecord): void {
  try {
    rmSync(record.paths.sessionDir, { recursive: true, force: true });
  } catch (error) {
    throw elwoodError("teardown_failed", "Could not remove Elwood session files.", {
      cause: error instanceof Error ? error.message : String(error),
      sessionDir: record.paths.sessionDir,
    });
  }
}

function warningKey(warning: ElwoodWarningEvent): string {
  const server =
    "mcpServerName" in warning ? warning.mcpServerName : warning.failedServers.join(",");
  return `${warning.code}:${server}`;
}

function recordPath(dir: string): string {
  return join(dir, "session.json");
}
