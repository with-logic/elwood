/** Both adapters read the live screen until their terminal is disposed (PRD §5.14, C-SCREEN-01/03). */
import { afterEach, expect, test } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

const numbered = Array.from({ length: 10 }, (_, index) => `row ${index}`).join("\r\n");
const notRunning = { code: "session_not_running" };

afterEach(() => {
  claude.resetFakes();
  codex.resetFakes();
});

for (const agent of ["claude", "codex"] as const) {
  const fake = agent === "claude" ? claude : codex;
  const start = agent === "claude" ? startClaude : startCodex;

  test(`C-SCREEN-01 a ${agent} session reads live rows while the host is scrolled back`, async () => {
    fake.installFakes();
    const session = await start({ cwd: fake.tempDir(), initialSize: { cols: 100, rows: 4 } });
    try {
      const written = [...fake.ptys[0]!.writes];
      fake.ptys[0]!.emitData(numbered);
      await session.terminal.settled();
      session.terminal.xterm.scrollToTop();
      expect(session.terminal.snapshot().lines[0]).toBe("row 0");
      expect(await session.readScreen({ scrollback: 2 })).toEqual({
        cols: 100,
        rows: 4,
        lines: ["row 6", "row 7", "row 8", "row 9"],
        scrollback: ["row 4", "row 5"],
        cursor: { x: 5, y: 3, visible: true },
        buffer: "normal",
        outputLost: false,
      });
      expect(session.terminal.xterm.buffer.active.viewportY).toBe(0);
      expect(fake.ptys[0]!.writes).toEqual(written);
    } finally {
      await session.stop();
    }
  });

  test(`C-SCREEN-03 a ${agent} session reads the screen its CLI left after exit, then rejects once disposed`, async () => {
    fake.installFakes();
    const session = await start({ cwd: fake.tempDir(), initialSize: { cols: 100, rows: 4 } });
    fake.ptys[0]!.emitData("last words");
    fake.ptys[0]!.emitExit({ exitCode: 0 });
    expect(session.status).toBe("exited");
    const afterExit = session.readScreen();
    await session.stop(); // Joins the cleanup that disposes the terminal.
    expect((await afterExit).lines[0]).toBe("last words");
    await expect(session.readScreen()).rejects.toMatchObject(notRunning);
  });
}
