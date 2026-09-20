/**
 * Shared fixtures for Codex session model picker/switch conformance tests.
 * Supports PRD §5.7, C-API-23, C-API-24, C-API-35, and C-CODEX-14 coverage.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  asScreen,
  codexPickerCurrentIsDefault,
  codexPickerSplitMarkers,
  codexReasoningScreen,
  until,
} from "../helpers/model-pickers.ts";
import { ptys } from "./helpers.ts";

export { until };

export const userConfig = 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n\n[hooks]\n';

export function sandboxCodexHome(cwd: string): string {
  const home = join(cwd, "codex-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), userConfig);
  process.env["CODEX_HOME"] = home;
  return join(home, "config.toml");
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
  pty.emitData(asScreen(codexPickerCurrentIsDefault));
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

const originalCodexHome = process.env["CODEX_HOME"];

export function restoreCodexHome(): void {
  if (originalCodexHome === undefined) delete process.env["CODEX_HOME"];
  else process.env["CODEX_HOME"] = originalCodexHome;
}
