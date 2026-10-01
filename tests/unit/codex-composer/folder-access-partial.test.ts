/** Captured folder-access preludes outrank a stale composer (C-API-31/C-API-56). */
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { codexEmptyInputFrame } from "../../../src/codex/screen/empty-input.ts";
import { codexInputStaged } from "../../../src/codex/screen/staged-input.ts";
import { startCodex } from "../../../src/index.ts";
import * as codex from "../../codex/helpers.ts";
import { codexSmallComposer, codexTty } from "../../fixtures/trust-composer.ts";

const captured = readFileSync(
  new URL("../../fixtures/codex-0.156.1/folder-access.txt", import.meta.url),
  "utf8",
).split("\n");
// Derived partial repaints from captured rows; not a newly captured native sequence.
function capturedRow(index: number): string {
  const row = captured[index];
  if (row === undefined) throw new Error(`Missing captured folder-access row ${index}`);
  return row;
}
const prelude = capturedRow(0);
const selected = capturedRow(6);
const histories = [
  { name: "selected choice after prelude erasure", text: selected, allowed: false },
  { name: "prelude alone", text: prelude, allowed: false },
  { name: "prelude with single selected choice", text: `${prelude}\n${selected}`, allowed: false },
  {
    name: "bounded assistant quote",
    text: `• Native menu example:\n  ${prelude}\n  ${selected}`,
    allowed: true,
  },
  {
    name: "completed user history",
    text: `› Explain this menu\n  ${prelude}\n  ${selected}\n• Prior reply`,
    allowed: true,
  },
  { name: "standalone numbered user history", text: `${selected}\n\n• Prior reply`, allowed: true },
];
afterEach(() => {
  vi.useRealTimers();
  codex.resetFakes();
});

for (const payload of ["probe", ""]) {
  test.each(histories)(`C-API-31/C-API-56 ${payload || "empty"} below $name`, async ({
    text,
    allowed,
  }) => {
    codex.installFakes();
    const cwd = codex.tempDir();
    const session = await startCodex({
      cwd,
      initialSize: { cols: 200, rows: 32 },
      autotrust: false,
    });
    const pty = codex.ptys[0]!;
    try {
      await codex.becomeReady(session.elwoodSessionId, cwd);
      vi.useFakeTimers();
      if (payload) {
        const sent = session.sendPrompt(payload);
        await vi.advanceTimersByTimeAsync(200);
        await sent;
      }
      const composer = payload
        ? codexSmallComposer.replace("› Ask Codex to do anything", `› ${payload}`)
        : codexSmallComposer;
      const paint = async (history: string) => {
        const frame = `${history}\n${composer}`;
        const row = frame.split("\n").findLastIndex((line) => line.startsWith("›"));
        pty.emitData(`\u001b[2J\u001b[H${codexTty(frame)}\u001b[${row + 1};${payload.length + 3}H`);
        const settled = session.terminal.settled();
        await vi.advanceTimersByTimeAsync(1);
        await settled;
      };
      const clear = () =>
        payload
          ? codexInputStaged(session.terminal, payload)
          : codexEmptyInputFrame(session.terminal) !== undefined;
      await paint(text);
      const observedClear = clear();
      if (text === `${prelude}\n${selected}`) {
        // A later partial repaint may erase the prelude before the selected choice.
        await vi.advanceTimersByTimeAsync(500);
        await paint(selected);
        expect(clear()).toBe(false);
      }
      if (payload && !allowed) {
        await vi.advanceTimersByTimeAsync(4_100);
        expect({
          clear: observedClear,
          enters: pty.writes.filter((value) => value === "\r").length,
        }).toEqual({ clear: false, enters: 1 });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(pty.writes.filter((value) => value === "\r")).toHaveLength(1);
      } else expect(observedClear).toBe(allowed);
      // Fresh replacement of the gate restores positive composer evidence.
      await paint("");
      expect(clear()).toBe(true);
    } finally {
      vi.useRealTimers();
      await session.teardown();
    }
  });
}
