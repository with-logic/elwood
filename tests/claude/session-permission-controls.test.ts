/** Model controls cannot approve pending dialogs; expired work never runs later (C-API-23/24/37). */
import { afterEach, expect, test } from "vitest";
import { claudeScreenFactTable } from "../../src/claude/screen-table.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";
import { startClaude } from "../../src/index.ts";
import { createReadinessGate } from "../../src/runtime/session/readiness.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);
const menu = (selected: number) =>
  `Do you want to create\nfile.txt?\n${["1. Yes", "2. Yes, and allow edits for this session", "3. No"].map((row, i) => `${i + 1 === selected ? "❯" : " "} ${row}`).join("\n")}\nEsc to cancel`;
test.each([
  1, 2, 3,
])("C-API-28 resume never releases readiness over selected row %s", (selected) => {
  let ready = false;
  const gate = createReadinessGate(() => {
    ready = true;
  }, true);
  gate.observeReadinessFrame(
    readScreenFacts(claudeScreenFactTable, { text: menu(selected), title: "" }).facts,
  );
  expect(ready).toBe(false);
  gate.observeReadinessFrame(
    readScreenFacts(claudeScreenFactTable, { text: "❯ ", title: "" }).facts,
  );
  expect(ready).toBe(true);
  gate.ready.cancel();
});
test.each([
  "list",
  "set",
])("C-API-23 C-API-24 %s times out blocked and cannot execute after clearance", async (operation) => {
  installFakes();
  const session = await startClaude({ cwd: tempDir(), autotrust: false });
  const pty = ptys[0]!;
  pty.emitData(`\u001b[2J\u001b[H${menu(2).replaceAll("\n", "\r\n")}`);
  await expect.poll(() => session.status).toBe("blocked");
  const result =
    operation === "list"
      ? session.listModels({ timeoutMs: 100 })
      : session.setModel("haiku", { timeoutMs: 100 });
  await expect(result).rejects.toMatchObject({ code: "model_automation_failed" });
  expect(pty.writes).toEqual([]);
  pty.emitData("\u001b[2J\u001b[H❯ ");
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(pty.writes).toEqual([]);
  await session.stop();
});
test("C-API-22 compact recovery skips Enter if a permission dialog appears", async () => {
  installFakes();
  const session = await startClaude({ cwd: tempDir() });
  await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "InstructionsLoaded",
    session_id: "claude-1",
    cwd: session.cwd,
    file_path: "/tmp/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session_start",
  });
  const pty = ptys[0]!;
  const result = session.compact({ timeoutMs: 800 });
  const check = expect(result).rejects.toMatchObject({ code: "compact_failed" });
  await expect.poll(() => pty.writes.includes("\r")).toBe(true);
  const before = [...pty.writes];
  pty.emitData(`\u001b[2J\u001b[H${menu(3).replaceAll("\n", "\r\n")}`);
  await expect.poll(() => session.status).toBe("blocked");
  await check;
  expect(pty.writes).toEqual(before);
  await session.stop();
});

test("C-API-24 stale cache confirmation cannot own a later generic permission dialog", async () => {
  const { parseClaudeSwitchConfirmation } = await import(
    "../../src/claude/model-switch-confirmation.ts"
  );
  const { claudeModelCacheConfirmationOnYes: cache } = await import("../helpers/model-pickers.ts");
  expect(parseClaudeSwitchConfirmation(`${cache}\nEnter to confirm · Esc to cancel`)).toMatchObject(
    { isCacheWarning: true },
  );
  for (const selected of [1, 2, 3]) {
    expect(parseClaudeSwitchConfirmation(`${cache}\n${menu(selected)}`)).toBeUndefined();
  }
});
test("C-API-24 a partially rendered switch dialog cannot authorize model input", async () => {
  const { parseClaudeSwitchConfirmation } = await import(
    "../../src/claude/model-switch-confirmation.ts"
  );
  expect(parseClaudeSwitchConfirmation("Switch model?\n❯ No, go back")).toBeUndefined();
  expect(parseClaudeSwitchConfirmation("Switch model?\n❯ Yes, switch to Opus")).toBeUndefined();
});
