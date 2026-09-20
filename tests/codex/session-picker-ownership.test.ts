/** Human intervention revokes picker automation before further writes (C-API-55). */
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { withCodexConfigLock } from "../../src/codex/config/lock.ts";
import { startCodex } from "../../src/index.ts";
import { asScreen, codexPickerCurrentIsDefault, until } from "../helpers/model-pickers.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { restoreCodexHome, sandboxCodexHome } from "./session-models-helpers.ts";

afterEach(() => {
  resetFakes();
  restoreCodexHome();
});

test("C-API-55 a foreign picker appearing during the config wait gets no command or cleanup", async () => {
  installFakes();
  const cwd = tempDir();
  sandboxCodexHome(cwd);
  const session = await startCodex({ cwd });
  const held = Promise.withResolvers<void>();
  const holder = withCodexConfigLock(() => held.promise);
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const setting = session
      .setModel("gpt-5.4", { timeoutMs: 400 })
      .catch((error: unknown) => error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    ptys[0]!.emitData(asScreen(codexPickerCurrentIsDefault));
    await session.terminal.settled();
    held.resolve();
    await holder;
    expect(await setting).toMatchObject({ code: "model_automation_failed" });
    expect(ptys[0]!.writes).toEqual([]);
  } finally {
    held.resolve();
    await holder;
    await session.stop();
  }
});

test.each([
  "keys",
  "bytes",
  "xterm",
])("C-API-55 raw %s revoke owned navigation and cleanup", async (route) => {
  installFakes();
  const cwd = tempDir();
  sandboxCodexHome(cwd);
  const session = await startCodex({ cwd });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const listing = session.listModels({ timeoutMs: 400 }).catch((error: unknown) => error);
    await until(() => ptys[0]!.writes.includes("\r"));
    if (route === "keys") await session.sendKeys("human");
    else if (route === "bytes") await session.terminal.sendInput(Buffer.from("human"));
    else session.terminal.xterm.input("human");
    const before = [...ptys[0]!.writes];
    ptys[0]!.emitData(asScreen(codexPickerCurrentIsDefault));
    await session.terminal.settled();
    expect(await listing).toMatchObject({ code: "model_automation_failed" });
    expect(ptys[0]!.writes).toEqual(before);
  } finally {
    await session.stop();
  }
});

test.each([
  false,
  true,
])("C-CODEX-14 raw takeover preserves human configuration (changed: %s)", async (changed) => {
  installFakes();
  const cwd = tempDir();
  const configPath = sandboxCodexHome(cwd);
  const session = await startCodex({ cwd });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const setting = session
      .setModel("gpt-5.4", { timeoutMs: 500 })
      .catch((error: unknown) => error);
    await until(() => ptys[0]!.writes.includes("\r"));
    ptys[0]!.emitData(asScreen(codexPickerCurrentIsDefault));
    await session.terminal.settled();
    const warnings: string[] = [];
    session.on("warning", (event) => warnings.push(event.code));
    const original = readFileSync(configPath, "utf8");
    const chosen = 'model = "human-choice"\nmodel_reasoning_effort = "high"\n\n[hooks]\n';
    const write = ptys[0]!.write.bind(ptys[0]!);
    ptys[0]!.write = (input) => {
      if (changed) writeFileSync(configPath, chosen);
      write(input);
    };
    await session.sendKeys("\r");
    expect(await setting).toMatchObject({ code: "model_automation_failed" });
    expect(readFileSync(configPath, "utf8")).toBe(changed ? chosen : original);
    expect(warnings).toEqual(changed ? ["codex_default_model_persisted"] : []);
  } finally {
    await session.stop();
  }
});

test("C-API-55 raw takeover during command staging never clears the human composer", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const listing = session.listModels().catch((error: unknown) => error);
    await until(() => ptys[0]!.writes.includes("/model"));
    await session.sendKeys("human draft");
    const before = [...ptys[0]!.writes];
    expect(await listing).toMatchObject({ code: "model_automation_failed" });
    expect(ptys[0]!.writes).toEqual(before);
  } finally {
    await session.stop();
  }
});
