/** Ambiguous update overlays preserve the frame owner's retained hold (PRD §5.5, C-CODEX-12). */
import { afterEach, expect, test, vi } from "vitest";
import { liveCodexClearance } from "../../src/codex/screen/live-clearance.ts";
import { startCodex } from "../../src/index.ts";
import { codexSmallComposer, codexTty } from "../fixtures/trust-composer.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test.each([
  false,
  true,
])("C-CODEX-12 update overlay withholds automation and respects replacement history (%s)", async (replacement) => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  const answered: string[] = [];
  session.on("activity", (event) => {
    if (event.kind === "startup_prompt") answered.push(event.label);
  });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    expect(session.status).toBe("ready");
    vi.useFakeTimers();
    const pty = ptys[0]!;
    const composer = `\u001b[2J\u001b[H${codexTty(`\n\n\n\n\n${codexSmallComposer}`)}`;
    pty.emitData(composer);
    await vi.advanceTimersByTimeAsync(50);
    pty.emitData(
      "\u001b7\u001b[HUpdate available! 0.151.0 -> 0.152.0\r\n1. Update now\r\n2. Skip\u001b8",
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(pty.writes).toEqual([]);
    pty.emitData(
      replacement
        ? "\u001b7\u001b[H\u001b[2KConfirm archive removal?\r\n\u001b[2K\r\n\u001b[2K\u001b8"
        : composer,
    );
    await vi.advanceTimersByTimeAsync(300);
    const frame = session.terminal.snapshot();
    expect(liveCodexClearance(() => session.terminal)(frame.text)).toBe(true);
    expect(answered).toEqual([]);
    expect(session.status).toBe(replacement ? "blocked" : "ready");
    if (replacement) {
      pty.emitData("\u001b[2J\u001b[H1. Update now\r\n2. Skip");
      await vi.advanceTimersByTimeAsync(300);
      expect(session.status).toBe("blocked");
      expect(pty.writes).toEqual([]);
    }
  } finally {
    vi.useRealTimers();
    await session.stop();
  }
});

test("C-CODEX-12 a clean native update answers once after its composer returns", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  const answered: string[] = [];
  session.on("activity", (event) => {
    if (event.kind === "startup_prompt") answered.push(event.label);
  });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    vi.useFakeTimers();
    ptys[0]!.emitData(
      "\u001b[2J\u001b[HUpdate available! 0.155.1 -> 0.156.1\r\n1. Update now\r\n2. Skip",
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(ptys[0]!.writes).toEqual(["2"]);
    ptys[0]!.emitData(`\u001b[2J\u001b[H${codexTty(codexSmallComposer)}`);
    await vi.advanceTimersByTimeAsync(300);
    expect(answered).toEqual(["update"]);
    expect(session.status).toBe("ready");
  } finally {
    vi.useRealTimers();
    await session.stop();
  }
});
