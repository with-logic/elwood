/**
 * Conformance tests for rendered-TUI turn boundaries on Codex sessions.
 * Covers PRD §5.3, C-TURN-01, C-TURN-02, and C-TURN-03.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSession turn boundaries", () => {
  test("C-TURN-02 an interrupted turn transitions to ready without a Stop hook", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    ptys[0]!.emitData("codex rendered\r\n› ");
    await expect.poll(() => session.status).toBe("ready");
    ptys[0]!.emitData("• Working (3s • esc to interrupt)\r\n› ");
    await expect.poll(() => session.status).toBe("running");
    ptys[0]!.emitData("\u001b[2J\u001b[H■ Conversation interrupted\r\n› ");
    await expect.poll(() => session.status).toBe("ready");
    await session.sendMessage("follow-up after interrupt");
    expect(ptys[0]!.writes.join("")).toContain("follow-up after interrupt");
  });

  test("C-ATTN-01 a rendered approval dialog blocks and emits attention", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const attention: string[] = [];
    session.on("activity", (event) => {
      if (event.kind === "attention") attention.push(event.label);
    });

    ptys[0]!.emitData("codex rendered\r\n› ");
    await expect.poll(() => session.status).toBe("ready");
    ptys[0]!.emitData(
      "[2J[HWould you like to run the following command?\r\n $ rm -rf build\r\n › 1. Yes (y)\r\n Press enter to confirm or esc to cancel\r\n",
    );
    await expect.poll(() => session.status).toBe("blocked");
    expect(attention).toEqual(["codex-approval-dialog"]);
    ptys[0]!.emitData("[2J[H› ");
    await expect.poll(() => session.status).toBe("ready");
  });

  test("C-API-34 waitForStatus and waitForActivity resolve on Codex sessions", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    await expect(session.waitForStatus((s) => s === "running")).resolves.toBe("running");
    const wait = session.waitForActivity((e) => e.kind === "attention");
    ptys[0]!.emitData("codex rendered\r\n\u203a ");
    await expect.poll(() => session.status).toBe("ready");
    ptys[0]!.emitData(
      "\u001b[2J\u001b[HWould you like to run the following command?\r\n \u203a 1. Yes (y)\r\n Press enter to confirm or esc to cancel\r\n",
    );
    await expect(wait).resolves.toMatchObject({ kind: "attention" });
  });

  test("C-TURN-03 the pre-ready MCP boot spinner does not fabricate a turn", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    // Codex renders "esc to interrupt" during MCP boot, before readiness.
    ptys[0]!.emitData("Booting MCP server: codex_apps (3s • esc to interrupt)\r\n");
    expect(session.status).toBe("running");
    ptys[0]!.emitData("\u001b[2J\u001b[H› ");
    await expect.poll(() => session.status).toBe("ready");
    // The boot spinner never produced a running/ready turn cycle of its own.
    expect(ptys[0]!.writes).toEqual([]);
  });
});
