/**
 * Conformance tests for Claude session model listing and switching.
 * Covers PRD §5.3, C-API-23, and C-API-24.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import {
  asScreen,
  claudeEffortCacheConfirmation,
  claudeHookSwitchConfirmation,
  claudeHookSwitchConfirmationWithCacheReason,
  claudeModelCacheConfirmationOnNo,
  claudeModelCacheConfirmationOnYes,
  claudeModelCacheConfirmationYesBelow,
  claudeModelCacheConfirmationYesBelowSelected,
  claudePicker,
  claudePickerCursorOnHaiku,
} from "../helpers/model-pickers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const instructionsLoaded = (cwd: string) => ({
  hook_event_name: "InstructionsLoaded",
  session_id: "claude-1",
  cwd,
  file_path: "/tmp/CLAUDE.md",
  memory_type: "Project",
  load_reason: "session_start",
});

describe("ClaudeSessionApi model picker", () => {
  test("C-API-23 listModels drives the picker through the readiness queue", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    const listing = session.listModels({ timeoutMs: 4_000 });
    await expect.poll(() => ptys[0]!.writes.includes("/model")).toBe(true);
    ptys[0]!.emitData(asScreen(claudePicker));
    await expect.poll(() => ptys[0]!.writes.includes("\u001b")).toBe(true);
    ptys[0]!.emitData(asScreen("❯ "));
    const options = await listing;
    expect(options.map((option) => option.id)).toEqual([
      "default",
      "opus",
      "fable",
      "sonnet",
      "haiku",
    ]);
    expect(options.find((option) => option.isCurrent)?.id).toBe("fable");
  });

  test("C-API-24 setModel navigates with arrows and applies session-only", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    const setting = session.setModel("haiku", { timeoutMs: 4_000 });
    await expect.poll(() => ptys[0]!.writes.includes("/model")).toBe(true);
    ptys[0]!.emitData(asScreen(claudePicker));
    await expect.poll(() => ptys[0]!.writes.filter((write) => write === "\u001b[B").length).toBe(2);
    ptys[0]!.emitData(asScreen(claudePickerCursorOnHaiku));
    await expect.poll(() => ptys[0]!.writes.includes("s")).toBe(true);
    ptys[0]!.emitData(asScreen("❯ "));
    await setting;
    expect(ptys[0]!.writes).not.toContain("\r5");
  });

  test("C-API-24 setModel accepts the model cache warning and waits for the composer", async () => {
    const { enterCount, setting, pty } = await driveSetModelToApply();
    pty.emitData(asScreen(`❯\n${claudeModelCacheConfirmationOnNo}`));
    await expect.poll(() => pty.writes.includes("\u001b[A")).toBe(true);
    pty.emitData(asScreen(`❯\n${claudeModelCacheConfirmationOnYes}`));
    await expect
      .poll(() => pty.writes.filter((write) => write === "\r").length)
      .toBeGreaterThan(enterCount);
    expect(await isSettled(setting)).toBe(false);
    pty.emitData(asScreen("❯ "));
    await setting;
  });

  test("C-API-24 setModel accepts the numbered effort cache warning", async () => {
    const { enterCount, setting, pty } = await driveSetModelToApply();
    pty.emitData(asScreen(claudeEffortCacheConfirmation));
    await expect
      .poll(() => pty.writes.filter((write) => write === "\r").length)
      .toBeGreaterThan(enterCount);
    expect(await isSettled(setting)).toBe(false);
    pty.emitData(asScreen("❯ "));
    await setting;
  });

  test("C-API-24 setModel follows a reordered cache-warning cursor downward", async () => {
    const { enterCount, setting, pty } = await driveSetModelToApply();
    pty.emitData(asScreen(claudeModelCacheConfirmationYesBelow));
    await expect.poll(() => pty.writes.filter((write) => write === "\u001b[B").length).toBe(3);
    pty.emitData(asScreen(claudeModelCacheConfirmationYesBelowSelected));
    await expect
      .poll(() => pty.writes.filter((write) => write === "\r").length)
      .toBeGreaterThan(enterCount);
    pty.emitData(asScreen("❯ "));
    await setting;
  });

  test("C-API-24 leaves PreModelSwitch hook confirmations to the human", async () => {
    const { session, setting, pty } = await driveSetModelToApply();
    pty.emitData(asScreen(claudeHookSwitchConfirmation));
    expect(await isSettled(setting)).toBe(false);
    expect(pty.writes.at(-1)).toBe("s");
    await session.sendKeys("\r");
    pty.emitData(asScreen("❯ "));
    await setting;
  });

  test("C-API-24 ignores cache copy inside a PreModelSwitch hook reason", async () => {
    const { enterCount, session, setting, pty } = await driveSetModelToApply();
    pty.emitData(asScreen(claudeHookSwitchConfirmationWithCacheReason));
    expect(await isSettled(setting)).toBe(false);
    expect(enterWrites(pty)).toBe(enterCount);
    await session.sendKeys("\r");
    pty.emitData(asScreen("❯ "));
    await setting;
  });

  test("C-API-24 does not combine transcript cache copy with a live hook dialog", async () => {
    const { enterCount, session, setting, pty } = await driveSetModelToApply();
    pty.emitData(asScreen(`${claudeModelCacheConfirmationOnYes}\n${claudeHookSwitchConfirmation}`));
    expect(await isSettled(setting)).toBe(false);
    expect(enterWrites(pty)).toBe(enterCount);
    await session.sendKeys("\r");
    pty.emitData(asScreen("❯ "));
    await setting;
  });

  test("C-API-24 treats a quoted cache dialog above the composer as transcript", async () => {
    const { enterCount, setting, pty } = await driveSetModelToApply();
    pty.emitData(asScreen(`${claudeModelCacheConfirmationOnYes}\n❯ `));
    await setting;
    expect(enterWrites(pty)).toBe(enterCount);
  });
});

async function driveSetModelToApply() {
  const cwd = tempDir();
  installFakes();
  const session = await startClaude({ cwd });
  await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
  const setting = session.setModel("haiku", { timeoutMs: 4_000 });
  await until(() => ptys[0]!.writes.includes("/model"));
  ptys[0]!.emitData(asScreen(claudePicker));
  await until(() => ptys[0]!.writes.filter((write) => write === "\u001b[B").length === 2);
  ptys[0]!.emitData(asScreen(claudePickerCursorOnHaiku));
  await until(() => ptys[0]!.writes.includes("s"));
  const pty = ptys[0]!;
  return {
    session,
    setting,
    pty,
    enterCount: enterWrites(pty),
  };
}

function enterWrites(pty: (typeof ptys)[number]): number {
  return pty.writes.filter((write) => write === "\r").length;
}

async function isSettled(promise: Promise<void>): Promise<boolean> {
  return await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 150)),
  ]);
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for model picker test state.");
}
