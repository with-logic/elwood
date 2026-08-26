/**
 * Conformance tests for Codex lifecycle edge behavior after exit and teardown.
 * Covers PRD §5.5, §5.7, and §9.
 */

import { afterEach, describe, expect, test } from "vitest";
import type { CodexSessionImpl } from "../../src/codex/session-instance.ts";
import { startCodex } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSessionApi lifecycle edges", () => {
  test("C-API-11 resize resolves without rendering when the PTY is closed", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    ptys[0]!.resizeResult = "closed";
    await session.resize({ cols: 55, rows: 22 });
    expect(ptys[0]!.size).toEqual({ cols: 189, rows: 48 });
    expect(session.terminal.size).toEqual({ cols: 189, rows: 48 });
  });

  test("C-LIFE-03 teardown of a running session force-kills the PTY", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    await session.teardown();
    expect(session.status).toBe("torn_down");
    expect(ptys[0]!.killSignals).toEqual(["SIGKILL"]);
  });

  test("C-LIFE-02 stop, kill, and late lifecycle markers are no-ops after exit", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const statuses: string[] = [];
    session.on("status", (event) => statuses.push(event.status));
    ptys[0]!.emitExit({ exitCode: 3 });
    expect(session.status).toBe("exited");
    await session.stop();
    await session.kill();
    (session as CodexSessionImpl).submitEvidence("rendered_turn_started");
    (session as CodexSessionImpl).submitEvidence("rendered_turn_ended");
    expect(session.status).toBe("exited");
    expect(ptys[0]!.killSignals).toEqual([]);
    expect(statuses).toEqual(["exited"]);
  });

  test("C-CODEX-21 an out-of-enum reasoningEffort rejects before spawn", async () => {
    installFakes();
    await expect(
      startCodex({ cwd: tempDir(), reasoningEffort: "bogus" as never }),
    ).rejects.toMatchObject({
      code: "codex_invalid_reasoning_effort",
      message: expect.stringContaining("bogus"),
    });
    expect(ptys).toHaveLength(0); // validation happens before the launch — no PTY spawned
  });
});
