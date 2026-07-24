/**
 * Conformance tests for Codex session model listing.
 * Covers PRD §5.7, C-API-23, C-API-24, and C-API-35.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { asScreen, codexPickerCurrentIsDefault } from "../helpers/model-pickers.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import {
  driveSetModel,
  restoreCodexHome,
  sandboxCodexHome,
  until,
  userConfig,
} from "./session-models-helpers.ts";

afterEach(() => {
  resetFakes();
  restoreCodexHome();
});

describe("CodexSessionApi model picker", () => {
  test("C-API-23 listModels drives the picker through the readiness queue", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const listing = session.listModels({ timeoutMs: 30_000 });
    await expect.poll(() => ptys[0]!.writes.includes("/model")).toBe(true);
    ptys[0]!.emitData(asScreen(codexPickerCurrentIsDefault));
    await expect.poll(() => ptys[0]!.writes.includes("\u001b")).toBe(true);
    ptys[0]!.emitData(asScreen("\u203a "));
    const options = await listing;
    expect(options.map((option) => option.id)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(options[0]).toMatchObject({ isCurrent: true, isDefault: true });
  });

  test("C-API-35 listModels dispatches /model while a turn is still in flight", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    // A working spinner keeps the session in `running` (e.g. MCP boot). The
    // picker command must still dispatch rather than stall behind readiness.
    ptys[0]!.emitData("\u2022 Working (2s \u2022 esc to interrupt)\r\n\u203a ");
    expect(session.status).toBe("running");
    const listing = session.listModels({ timeoutMs: 30_000 });
    await expect.poll(() => ptys[0]!.writes.includes("/model")).toBe(true);
    ptys[0]!.emitData(asScreen(codexPickerCurrentIsDefault));
    await expect.poll(() => ptys[0]!.writes.includes("\u001b")).toBe(true);
    ptys[0]!.emitData(asScreen("\u203a "));
    expect((await listing).length).toBe(4);
  });

  test("C-API-24 setModel opens the picker reliably right after listModels", async () => {
    // Regression: a prior listModels() must not leave the control queue in a
    // state that stalls the next queued /model command (the picker never
    // opening would time out with model_automation_failed).
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");

    // First: listModels opens and closes the picker.
    const listing = session.listModels({ timeoutMs: 30_000 });
    await until(() => ptys[0]!.writes.filter((w) => w === "/model").length === 1);
    ptys[0]!.emitData(asScreen(codexPickerCurrentIsDefault));
    await until(() => ptys[0]!.writes.includes("\u001b"));
    ptys[0]!.emitData(asScreen("\u203a "));
    await listing;
    // Clear the write log so the drive helper counts only setModel's writes.
    ptys[0]!.writes.length = 0;

    // Then: setModel must submit a fresh /model — the queue must not stall
    // after the prior picker close — and drive the switch to completion.
    const configPath = sandboxCodexHome(cwd);
    const setting = session.setModel("gpt-5.4", { timeoutMs: 30_000 });
    await driveSetModel(configPath, userConfig);
    await setting;
    // setModel submitted its own /model, proving the queue did not stall.
    expect(ptys[0]!.writes.filter((w) => w === "/model").length).toBe(1);
  });
});
