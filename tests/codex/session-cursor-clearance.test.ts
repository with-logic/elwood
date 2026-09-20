/** Native cursor provenance distinguishes active composer from transcript (C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { startCodex } from "../../src/index.ts";
import { codexSmallComposer, codexTrust, tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

function paint(frame: string, cursorRow: number, visible = true) {
  return `\u001b[2J\u001b[H${tty(frame)}\u001b[${cursorRow + 1};3H\u001b[?25${visible ? "h" : "l"}`;
}

const nativeRow = codexSmallComposer.split("\n").findIndex((row) => row.startsWith("›"));

test.each([
  [
    "single replacement option above old composer",
    `Unrecognized permission\n› Continue\n${codexSmallComposer}`,
    1,
    false,
  ],
  ["hidden cursor beside stale native composer", codexSmallComposer, nativeRow, false],
  ["transcript placeholder with cursor elsewhere", codexSmallComposer, 0, true],
] as const)("C-TRUST-01 %s cannot release queued input", async (_name, frame, row, visible) => {
  installFakes();
  const session = await startCodex({ cwd: tempDir(), autotrust: false });
  try {
    vi.useFakeTimers();
    const pending = session.sendMessage("after cursor proof");
    void pending.catch(() => undefined);
    ptys[0]!.emitData(paint(`${codexTrust}\n› 1. Yes, continue\n  2. No, quit`, 4, false));
    await vi.advanceTimersByTimeAsync(6_000);
    ptys[0]!.emitData(paint(frame, row, visible));
    await vi.advanceTimersByTimeAsync(500);
    expect(ptys[0]!.writes).toEqual([]);
    ptys[0]!.emitData(paint(codexSmallComposer, nativeRow));
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(ptys[0]!.writes).toEqual(["\u001b[200~after cursor proof\u001b[201~", "\r"]);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});

test.each([
  '• The spinner says "esc to interrupt" while work runs.',
  "› 1. Show the first change\n\n• Here is the requested change.",
  "› Continue\n\n• Continuing the explanation.",
])("C-TRUST-01 transcript %s does not block the real native cursor", async (transcript) => {
  installFakes();
  const session = await startCodex({ cwd: tempDir(), autotrust: false });
  try {
    vi.useFakeTimers();
    const pending = session.sendMessage("after transcript");
    void pending.catch(() => undefined);
    ptys[0]!.emitData(paint(`${codexTrust}\n› 1. Yes, continue\n  2. No, quit`, 4, false));
    await vi.advanceTimersByTimeAsync(6_000);
    const frame = `${transcript}\n${codexSmallComposer}`;
    const row = transcript.split("\n").length + nativeRow;
    ptys[0]!.emitData(paint(frame, row));
    await vi.advanceTimersByTimeAsync(500);
    expect(ptys[0]!.writes).toEqual(["\u001b[200~after transcript\u001b[201~", "\r"]);
    await pending;
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
