/** A closed Codex config-lock waiter never touches user defaults (PRD §5.7, C-CODEX-14). */
import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { withCodexConfigLock } from "../../src/codex/config/lock.ts";
import { startCodex } from "../../src/index.ts";
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
