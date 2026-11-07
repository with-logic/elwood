/**
 * Shared fixtures for Codex session model picker/switch conformance tests.
 * Supports PRD §5.7, C-API-23, C-API-24, C-API-35, and C-CODEX-14 coverage.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexSessionApi } from "../../src/index.ts";
import { restoreCodexHome, useCodexHome } from "../helpers/codex-home.ts";
import {
  asScreen,
  codexPickerCurrentMarkerOnly,
  codexPickerSplitMarkers,
  codexReasoningScreen,
  until,
} from "../helpers/model-pickers.ts";
import { ptys, resetFakes } from "./helpers.ts";

export { restoreCodexHome } from "../helpers/codex-home.ts";
export { until };

const modelSessions: Pick<CodexSessionApi, "stop">[] = [];

/** Stop sessions before the adapter resets the process rows they still need. */
export function trackModelSession<T extends Pick<CodexSessionApi, "stop">>(session: T): T {
  modelSessions.push(session);
  return session;
}

export async function stopModelSessions(): Promise<void> {
  const outcomes = await Promise.allSettled(
    modelSessions.splice(0).map((session) => Promise.resolve().then(() => session.stop())),
  );
  const failures = outcomes.filter((outcome) => outcome.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Model session cleanup failed",
    );
  }
}

/** Keep shared process and home fixtures intact until every session stop settles. */
export async function cleanupModelSessions(): Promise<void> {
  try {
    await stopModelSessions();
  } finally {
    resetFakes();
    restoreCodexHome();
  }
}

export const userConfig = 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n\n[hooks]\n';

export function sandboxCodexHome(cwd: string): string {
  const home = join(cwd, "codex-home");
  mkdirSync(home, { recursive: true });
  const configPath = useCodexHome(home);
  writeFileSync(configPath, userConfig);
  return configPath;
}

export async function driveSetModel(
  configPath: string,
  persisted: string,
  ptyIndex = 0,
): Promise<void> {
  await driveUntilConfigWritten(configPath, persisted, ptyIndex);
  ptys[ptyIndex]!.emitData(asScreen("• Model changed to gpt-5.4 medium\n› "));
}

/**
 * Drives the picker through the point where Codex writes config.toml, then
 * stops WITHOUT the final "Model changed" confirmation so the last waitForScreen
 * times out and super.setModel rejects — exercising the finally-restore path
 * (C-CODEX-14).
 */
export async function driveUntilConfigWritten(
  configPath: string,
  persisted: string,
  ptyIndex = 0,
): Promise<void> {
  const pty = ptys[ptyIndex]!;
  await until(() => pty.writes.join("").includes("/model\r"));
  pty.emitData(asScreen(codexPickerCurrentMarkerOnly));
  await until(() => pty.writes.filter((w) => w === "[B").length === 1);
  pty.emitData(asScreen(codexPickerSplitMarkers));
  await until(() => pty.writes.filter((w) => w === "\r").length >= 2);
  // Simulate the CLI persisting the selection during confirmation.
  writeFileSync(configPath, persisted);
  pty.emitData(asScreen(codexReasoningScreen));
  await until(() => pty.writes.filter((w) => w === "\r").length >= 3);
}

export function becomeReadyFor(elwoodSessionId: string, cwd: string, ptyIndex: number) {
  return ptys[ptyIndex]!.dispatchHook(elwoodSessionId, {
    hook_event_name: "SessionStart",
    session_id: `codex-${ptyIndex + 1}`,
    cwd,
    model: "gpt-5.3-codex",
    source: "startup",
  });
}
