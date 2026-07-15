/**
 * Unit tests for the shared resize helpers, focusing on C-API-39's requirement
 * that the deferred restore separates PHYSICAL geometry from persistence: the
 * held size was already durably recorded, so restore must not re-persist (a
 * redundant persist failure must not masquerade as a bootstrap-width restore
 * failure). Covers PRD §5.3, C-API-39, C-PTY-05.
 */

import { describe, expect, test } from "vitest";
import type { TerminalSize } from "../../src/core/types.ts";
import type { PtyProcess } from "../../src/pty/types.ts";
import { restoreHeldResize } from "../../src/runtime/session-resize.ts";
import type { ElwoodTerminal } from "../../src/terminal/headless.ts";

type Harness = {
  pty: Pick<PtyProcess, "resize">;
  terminal: Pick<ElwoodTerminal, "resize">;
  ptyResizes: TerminalSize[];
  terminalResizes: TerminalSize[];
};

function harness(result: "resized" | "closed" | Error): Harness {
  const h: Harness = {
    ptyResizes: [],
    terminalResizes: [],
    pty: {} as Pick<PtyProcess, "resize">,
    terminal: {} as Pick<ElwoodTerminal, "resize">,
  };
  h.pty = {
    resize: (size: TerminalSize) => {
      h.ptyResizes.push(size);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  h.terminal = { resize: (size: TerminalSize) => h.terminalResizes.push(size) };
  return h;
}

describe("restoreHeldResize", () => {
  test("C-API-39 applies PTY and terminal geometry and reports applied — WITHOUT persisting", () => {
    const h = harness("resized");
    const size = { cols: 72, rows: 9 };
    // The helper takes no persist callback at all: the held size is already durable,
    // so a genuine restore only touches the two physical models. There is no persist
    // step whose failure could be misreported as a bootstrap-width restore failure.
    const applied = restoreHeldResize(h.pty as PtyProcess, h.terminal as ElwoodTerminal, size);
    expect(applied).toBe(true);
    expect(h.ptyResizes).toEqual([size]);
    expect(h.terminalResizes).toEqual([size]);
  });

  test("C-API-39 a closed fd is a silent no-op: terminal is untouched and it reports not-applied", () => {
    const h = harness("closed");
    const applied = restoreHeldResize(h.pty as PtyProcess, h.terminal as ElwoodTerminal, {
      cols: 72,
      rows: 9,
    });
    expect(applied).toBe(false);
    // The terminal model is NOT resized when the pty fd is already closed.
    expect(h.terminalResizes).toEqual([]);
  });

  test("C-API-39 a real native resize error propagates so the caller can warn durably", () => {
    const h = harness(Object.assign(new Error("resize failed"), { code: "EIO" }));
    expect(() =>
      restoreHeldResize(h.pty as PtyProcess, h.terminal as ElwoodTerminal, { cols: 72, rows: 9 }),
    ).toThrow("resize failed");
    // The physical PTY resize threw before the terminal model was touched.
    expect(h.terminalResizes).toEqual([]);
  });
});
