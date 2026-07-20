/**
 * Coverage for Claude image attach (PRD §5.3, C-API-45): each absolute path is
 * bracketed-pasted, sanitized, and the driver waits for the `[Image #N]` chip to
 * increment before the next paste; it proceeds if the chip never appears and
 * stops on abort. Fake timers keep the settle/poll waits instant.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { attachClaudeImages } from "../../src/claude/attach-images.ts";

const ESC = String.fromCharCode(27);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A fake terminal whose snapshot text adds a chip per paste (or never). */
function fakeTerminal(chipsPerPaste = 1) {
  const writes: string[] = [];
  let chips = 0;
  return {
    writes,
    sendInput(data: string): void {
      writes.push(data);
      chips += chipsPerPaste;
    },
    snapshot() {
      return { text: Array.from({ length: chips }, (_, i) => `[Image #${i + 1}]`).join(" ") };
    },
  };
}

describe("attachClaudeImages (C-API-45)", () => {
  test("C-API-45 bracketed-pastes each absolute path and waits for its chip", async () => {
    const term = fakeTerminal();
    const done = attachClaudeImages(
      term,
      ["/abs/a.png", "/abs/b.png"],
      new AbortController().signal,
    );
    await vi.runAllTimersAsync();
    await done;
    expect(term.writes).toEqual([
      `${ESC}[200~/abs/a.png${ESC}[201~`,
      `${ESC}[200~/abs/b.png${ESC}[201~`,
    ]);
  });

  test("C-API-45 sanitizes a path that carries an embedded end sentinel", async () => {
    const term = fakeTerminal();
    const done = attachClaudeImages(term, [`/abs/${ESC}[201~x.png`], new AbortController().signal);
    await vi.runAllTimersAsync();
    await done;
    expect(term.writes[0]).toBe(`${ESC}[200~/abs/[201~x.png${ESC}[201~`);
  });

  test("C-API-45 proceeds when the chip never appears (matcher drift is not a deadlock)", async () => {
    const term = fakeTerminal(0);
    const done = attachClaudeImages(term, ["/abs/a.png"], new AbortController().signal);
    await vi.runAllTimersAsync();
    await done;
    expect(term.writes).toHaveLength(1);
  });

  test("C-API-45 aborts the poll loop when the signal fires mid-wait", async () => {
    const term = fakeTerminal(0);
    const controller = new AbortController();
    const done = attachClaudeImages(term, ["/abs/a.png"], controller.signal);
    controller.abort();
    await vi.runAllTimersAsync();
    await done;
    expect(term.writes).toHaveLength(1); // the first paste went out, then the wait bailed
  });

  test("C-API-45 stops early when the signal is already aborted", async () => {
    const term = fakeTerminal();
    const controller = new AbortController();
    controller.abort();
    const done = attachClaudeImages(term, ["/abs/a.png"], controller.signal);
    await vi.runAllTimersAsync();
    await done;
    expect(term.writes).toHaveLength(0);
  });
});
