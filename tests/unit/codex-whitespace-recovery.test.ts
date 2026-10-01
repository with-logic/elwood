/** Cursor-owned whitespace consumes bounded recovery without releasing a dirty draft (C-API-31/56). */

import { afterEach, expect, test, vi } from "vitest";
import { codexInputStaged } from "../../src/codex/screen/staged-input.ts";
import { composerClearKeys } from "../../src/core/input/constants.ts";
import { cancellableSubmission } from "../../src/core/input/submission-cancel.ts";
import { startCodex } from "../../src/index.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import * as codex from "../codex/helpers.ts";
import { readNativeInputFrame } from "../fixtures/native-input-frame.ts";
import { cursorFrame } from "../fixtures/owned-turn/composer.ts";
import { codexSmallComposer, codexTty } from "../fixtures/trust-composer.ts";

const frame = readNativeInputFrame(
  new URL("../fixtures/codex-0.159.2/whitespace-only-input.json", import.meta.url),
);
const payload = "  \t ";
const encoded = (
  text = frame.text,
  x = frame.cursorX,
  y = frame.cursorY,
  visible = true,
  title = frame.title,
) => cursorFrame(text, x, y, visible, title);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  codex.resetFakes();
});

test("C-API-31 captured whitespace requires the visible cursor-owned live idle row", async () => {
  const terminal = createHeadlessTerminal({ cols: frame.cols, rows: frame.rows }, () => {});
  try {
    expect(codexInputStaged(terminal, payload)).toBe(false);
    await terminal.writeOutput(encoded());
    expect(codexInputStaged(terminal, payload)).toBe(true);
    expect(codexInputStaged(terminal, "")).toBe(false);
    expect(codexInputStaged(terminal, "different text")).toBe(false);
    for (const invalid of [
      encoded(frame.text, 2),
      encoded(frame.text, 6, frame.cursorY, false),
      encoded(frame.text, 6, frame.cursorY, true, "⠋ Working"),
      encoded(frame.text, 6, frame.cursorY + 1),
      encoded(`${frame.text}\nUnknown footer: continue?`),
      encoded(frame.text.replace("›", "› Ask Codex to do anything")),
      encoded(frame.text.replace("›", "›\nnot indented"), 6, frame.cursorY + 1),
      encoded(`Would you like to run the following command?\n${frame.text}`, 6, frame.cursorY + 1),
    ]) {
      await terminal.writeOutput(invalid);
      expect(codexInputStaged(terminal, payload)).toBe(false);
    }
  } finally {
    terminal.dispose();
  }
});

test("C-API-56 captured whitespace exhausts two retries and retains successor cleanup", async () => {
  codex.installFakes();
  const cwd = codex.tempDir();
  const session = await startCodex({ cwd, initialSize: { cols: frame.cols, rows: frame.rows } });
  const pty = codex.ptys[0]!;
  const abort = new AbortController();
  const write = pty.write.bind(pty);
  let clears = 0;
  vi.spyOn(pty, "write").mockImplementation((data) => {
    write(data);
    if (data === composerClearKeys && ++clears === 1)
      pty.emitData(
        "\u001b[2J\u001b[HWould you like to run the following command?\r\n› 1. Yes\r\n  2. No\r\nPress enter to confirm or esc to cancel",
      );
  });
  const paint = async (text: string) => {
    pty.emitData(text);
    const settled = session.terminal.settled();
    await vi.advanceTimersByTimeAsync(1);
    await settled;
  };
  try {
    await codex.becomeReady(session.elwoodSessionId, cwd);
    vi.useFakeTimers();
    const replay = session.sendMessage(payload, cancellableSubmission(undefined, abort.signal));
    const outcome = replay.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(150);
    const next = session.sendPrompt("successor");
    void next.catch(() => undefined);
    for (const count of [2, 3]) {
      await paint(encoded());
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(count);
      expect(pty.writes.some((value) => value.includes("successor"))).toBe(false);
    }
    await paint(encoded());
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await outcome).toMatchObject({ code: "wait_timeout" });
    expect(session.status).toBe("blocked");
    expect(pty.writes.filter((value) => value === "\r")).toHaveLength(3);
    expect(pty.writes.some((value) => value.includes("successor"))).toBe(false);
    await paint(`\u001b[2J\u001b[H${codexTty(codexSmallComposer)}`);
    await vi.advanceTimersByTimeAsync(100);
    expect(clears).toBe(2);
    expect(pty.writes.some((value) => value.includes("successor"))).toBe(false);
    await paint(`\u001b[2J\u001b[H${codexTty(codexSmallComposer)}`);
    await vi.advanceTimersByTimeAsync(250);
    await next;
    expect(pty.writes).toContain("\u001b[200~successor\u001b[201~");
  } finally {
    abort.abort();
    vi.useRealTimers();
    await session.teardown();
  }
});
