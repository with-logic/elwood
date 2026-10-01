/** Partial-dialog veto applies to captured whitespace through ordinary and awaited input (C-API-31/56). */
import { afterEach, expect, test, vi } from "vitest";
import { codexEmptyInputFrame } from "../../src/codex/screen/empty-input.ts";
import { codexInputStaged } from "../../src/codex/screen/staged-input.ts";
import { cancellableSubmission } from "../../src/core/input/submission-cancel.ts";
import { startCodex } from "../../src/index.ts";
import * as codex from "../codex/helpers.ts";
import { readNativeInputFrame } from "../fixtures/native-input-frame.ts";

afterEach(() => {
  vi.useRealTimers();
  codex.resetFakes();
});

test.each([
  false,
  true,
])("C-API-56 partial approval with native whitespace withholds Enter and acceptance; awaited=%s", async (awaited) => {
  codex.installFakes();
  const frame = readNativeInputFrame(
    new URL("../fixtures/codex-0.159.2/whitespace-only-input.json", import.meta.url),
  );
  const cwd = codex.tempDir();
  const session = await startCodex({
    cwd,
    initialSize: { cols: frame.cols, rows: frame.rows },
    autotrust: false,
  });
  const pty = codex.ptys[0]!;
  const cancellation = new AbortController();
  const paint = async (partial: boolean, empty: boolean) => {
    const rows = frame.text.split("\n");
    rows[28] = partial ? "  Allow command?" : "";
    rows[29] = partial ? "  1. Yes" : "";
    if (empty) rows[frame.cursorY] = "› Ask Codex to do anything";
    pty.emitData(
      `\u001b[2J\u001b[H${rows.join("\r\n")}\u001b[${frame.cursorY + 1};${empty ? 3 : frame.cursorX + 1}H\u001b[?25h\u001b]0;Ready\u0007`,
    );
    const rendered = session.terminal.settled();
    await vi.advanceTimersByTimeAsync(1);
    await rendered;
  };
  let settled = false;
  let successor: Promise<void> | undefined;
  try {
    await codex.becomeReady(session.elwoodSessionId, cwd);
    vi.useFakeTimers();
    const pending = session.sendMessage(
      "  \t ",
      awaited ? cancellableSubmission(undefined, cancellation.signal) : undefined,
    );
    void pending.then(
      () => {
        settled = true;
      },
      () => undefined,
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(pty.writes.filter((value) => value === "\r")).toHaveLength(1);
    await paint(true, false);
    expect(session.terminal.snapshot().cursorX).toBe(6);
    expect(codexInputStaged(session.terminal, "  \t ")).toBe(false);
    expect(codexEmptyInputFrame(session.terminal)).toBeUndefined();
    if (awaited) {
      successor = session.sendPrompt("successor");
      void successor.catch(() => undefined);
    }
    await vi.advanceTimersByTimeAsync(1_100);
    expect(pty.writes.filter((value) => value === "\r")).toHaveLength(1);
    expect(settled).toBe(!awaited);
    await paint(true, true); // even empty-looking input under the same partial dialog cannot acknowledge
    await vi.advanceTimersByTimeAsync(1_100);
    expect(codexEmptyInputFrame(session.terminal)).toBeUndefined();
    expect(settled).toBe(!awaited);
    expect(pty.writes.some((value) => value.includes("successor"))).toBe(false);
    await paint(false, true); // a later complete native empty frame, after the overlay has gone
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(settled).toBe(true);
    if (successor) {
      await successor;
      expect(pty.writes).toContain("\u001b[200~successor\u001b[201~");
    }
  } finally {
    cancellation.abort();
    vi.useRealTimers();
    await session.teardown();
    if (successor) await Promise.allSettled([successor]);
  }
});
