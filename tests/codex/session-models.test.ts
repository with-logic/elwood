/**
 * Conformance tests for Codex session model listing and switching.
 * Covers PRD §5.7, C-API-23, C-API-24, and C-CODEX-14.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import {
  asScreen,
  codexPickerCurrentIsDefault,
  codexPickerSplitMarkers,
  codexReasoningScreen,
} from "../helpers/model-pickers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const originalCodexHome = process.env["CODEX_HOME"];
const userConfig = 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n\n[hooks]\n';

function sandboxCodexHome(cwd: string): string {
  const home = join(cwd, "codex-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), userConfig);
  process.env["CODEX_HOME"] = home;
  return join(home, "config.toml");
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 160; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("picker flow condition not reached");
}

async function driveSetModel(configPath: string, persisted: string): Promise<void> {
  await until(() => ptys[0]!.writes.includes("/model"));
  ptys[0]!.emitData(asScreen(codexPickerCurrentIsDefault));
  await until(() => ptys[0]!.writes.filter((w) => w === "\u001b[B").length === 1);
  ptys[0]!.emitData(asScreen(codexPickerSplitMarkers));
  await until(() => ptys[0]!.writes.filter((w) => w === "\r").length >= 2);
  // Simulate the CLI persisting the selection during confirmation.
  writeFileSync(configPath, persisted);
  ptys[0]!.emitData(asScreen(codexReasoningScreen));
  await until(() => ptys[0]!.writes.filter((w) => w === "\r").length >= 3);
  ptys[0]!.emitData(asScreen("• Model changed to gpt-5.4 medium\n› "));
}

afterEach(() => {
  resetFakes();
  if (originalCodexHome === undefined) delete process.env["CODEX_HOME"];
  else process.env["CODEX_HOME"] = originalCodexHome;
});

describe("CodexSession model picker", () => {
  test("C-API-23 listModels drives the picker through the readiness queue", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    ptys[0]!.emitData("codex rendered\r\n› ");
    await expect.poll(() => session.status).toBe("ready");
    const listing = session.listModels({ timeoutMs: 4_000 });
    await expect.poll(() => ptys[0]!.writes.includes("/model")).toBe(true);
    ptys[0]!.emitData(asScreen(codexPickerCurrentIsDefault));
    await expect.poll(() => ptys[0]!.writes.includes("\u001b")).toBe(true);
    ptys[0]!.emitData(asScreen("› "));
    const options = await listing;
    expect(options.map((option) => option.id)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(options[0]).toMatchObject({ isCurrent: true, isDefault: true });
  });

  test("C-CODEX-14 setModel restores the user's persisted default", async () => {
    const cwd = tempDir();
    const configPath = sandboxCodexHome(cwd);
    installFakes();
    const session = await startCodex({ cwd });
    ptys[0]!.emitData("codex rendered\r\n› ");
    await expect.poll(() => session.status).toBe("ready");
    const setting = session.setModel("gpt-5.4", { timeoutMs: 4_000 });
    await driveSetModel(
      configPath,
      'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\n\n[hooks]\n',
    );
    await setting;
    expect(readFileSync(configPath, "utf8")).toBe(userConfig);
    expect(session.warnings).toEqual([]);
  });

  test("C-CODEX-14 setModel warns instead of clobbering concurrent config edits", async () => {
    const cwd = tempDir();
    const configPath = sandboxCodexHome(cwd);
    installFakes();
    const session = await startCodex({ cwd });
    ptys[0]!.emitData("codex rendered\r\n› ");
    await expect.poll(() => session.status).toBe("ready");
    const setting = session.setModel("gpt-5.4", { timeoutMs: 4_000 });
    const concurrent = 'model = "gpt-5.4"\nextra = true\n\n[hooks]\n';
    await driveSetModel(configPath, concurrent);
    await setting;
    expect(readFileSync(configPath, "utf8")).toBe(concurrent);
    expect(session.warnings).toMatchObject([{ code: "codex_default_model_persisted" }]);
  });
});
