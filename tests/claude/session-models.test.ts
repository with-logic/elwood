/**
 * Conformance tests for Claude session model listing and switching.
 * Covers PRD §5.3, C-API-23, and C-API-24.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { asScreen, claudePicker, claudePickerCursorOnHaiku } from "../helpers/model-pickers.ts";
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

describe("ClaudeSession model picker", () => {
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
});
