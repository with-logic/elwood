/** A closed Codex config-lock waiter never touches user defaults (PRD §5.7, C-CODEX-14). */
import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { withCodexConfigLock } from "../../src/codex/config/lock.ts";
import { startCodex } from "../../src/index.ts";
import { asScreen, codexPickerCurrentIsDefault } from "../helpers/model-pickers.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { restoreCodexHome, sandboxCodexHome, userConfig } from "./session-models-helpers.ts";

afterEach(() => {
  resetFakes();
  restoreCodexHome();
});

test("C-CODEX-14 closing a setModel waiter rejects before the config owner releases", async () => {
  installFakes();
  const cwd = tempDir();
  const configPath = sandboxCodexHome(cwd);
  const session = await startCodex({ cwd });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const acquired = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const holder = withCodexConfigLock(async () => {
    entered();
    await held;
  });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    await acquired;
    const before = [...ptys[0]!.writes];
    const setting = session.setModel("gpt-5.4").catch((error: unknown) => error);
    // Let the session's exclusive queue reach the held process-wide mutex.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await session.kill();
    expect(await setting).toMatchObject({ code: "session_not_running" });
    expect(readFileSync(configPath, "utf8")).toBe(userConfig);
    expect(ptys[0]!.writes).toEqual(before);
    release();
    await holder;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readFileSync(configPath, "utf8")).toBe(userConfig);
    expect(ptys[0]!.writes).toEqual(before);
  } finally {
    release();
    await holder;
    await session.stop();
  }
});

test("C-API-55 a setModel deadline cancels a config-lock waiter and releases its input slot", async () => {
  installFakes();
  const cwd = tempDir();
  const configPath = sandboxCodexHome(cwd);
  const session = await startCodex({ cwd });
  const held = Promise.withResolvers<void>();
  const holder = withCodexConfigLock(() => held.promise);
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    let failure: unknown;
    const setting = session.setModel("gpt-5.4", { timeoutMs: 20 }).catch((error: unknown) => {
      failure = error;
    });
    await expect
      .poll(() => failure, { timeout: 2_000 })
      .toMatchObject({ code: "model_automation_failed" });
    await setting;
    expect(ptys[0]!.writes).toEqual([]);
    expect(readFileSync(configPath, "utf8")).toBe(userConfig);
    await session.sendMessage("after timeout");
    expect(ptys[0]!.writes).toContain("\u001b[200~after timeout\u001b[201~");
    held.resolve();
    await holder;
    await new Promise((resolve) => setImmediate(resolve));
    expect(ptys[0]!.writes).not.toContain("/model");
    expect(readFileSync(configPath, "utf8")).toBe(userConfig);
  } finally {
    held.resolve();
    await holder;
    await session.stop();
  }
});

test("C-API-55 a config-lock timeout never cancels a picker opened by someone else", async () => {
  installFakes();
  const cwd = tempDir();
  const configPath = sandboxCodexHome(cwd);
  const session = await startCodex({ cwd });
  const held = Promise.withResolvers<void>();
  const holder = withCodexConfigLock(() => held.promise);
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const setting = session
      .setModel("gpt-5.4", { timeoutMs: 100 })
      .catch((error: unknown) => error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    ptys[0]!.emitData(asScreen(codexPickerCurrentIsDefault));
    await session.terminal.settled();
    expect(await setting).toMatchObject({ code: "model_automation_failed" });
    expect(ptys[0]!.writes).toEqual([]);
    expect(readFileSync(configPath, "utf8")).toBe(userConfig);
    const queued = session.sendMessage("after foreign picker");
    void queued.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ptys[0]!.writes).toEqual([]);
    ptys[0]!.emitData(asScreen("› Ask Codex to do anything\n  gpt-5.5 high"));
    await session.terminal.settled();
    await queued;
    expect(ptys[0]!.writes).toEqual(["\u001b[200~after foreign picker\u001b[201~", "\r"]);
    const beforeRelease = [...ptys[0]!.writes];
    held.resolve();
    await holder;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ptys[0]!.writes).toEqual(beforeRelease);
  } finally {
    held.resolve();
    await holder;
    await session.stop();
  }
});
