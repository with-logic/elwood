/**
 * Coverage for Claude image attach (PRD §5.3, C-API-45): each absolute path is
 * bracketed-pasted, sanitized, and CONFIRMED by its `[Image #N]` chip; an
 * unconfirmed chip or an abort REJECTS with image_attach_failed (no silent
 * text-only degradation). Fake timers keep the settle/poll waits instant.
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
    settled: () => Promise.resolve(),
    renderFailed: false,
    sendInput(data: string): void {
      writes.push(data);
      chips += chipsPerPaste;
    },
    snapshot() {
      return {
        text: `› ${Array.from({ length: chips }, (_, i) => `[Image #${i + 1}]`).join(" ")}`,
      };
    },
  };
}

describe("attachClaudeImages (C-API-45)", () => {
  test("C-API-45 bracketed-pastes each absolute path and confirms via its chip", async () => {
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

  test("C-API-45 sanitizes a path carrying an embedded end sentinel", async () => {
    const term = fakeTerminal();
    const done = attachClaudeImages(term, [`/abs/${ESC}[201~x.png`], new AbortController().signal);
    await vi.runAllTimersAsync();
    await done;
    expect(term.writes[0]).toBe(`${ESC}[200~/abs/[201~x.png${ESC}[201~`);
  });

  test("C-API-45 rejects with image_attach_failed when the chip never appears", async () => {
    const term = fakeTerminal(0);
    const done = attachClaudeImages(term, ["/abs/a.png"], new AbortController().signal);
    const settled = expect(done).rejects.toMatchObject({ code: "image_attach_failed" });
    await vi.runAllTimersAsync();
    await settled;
  });

  test("C-API-44 clears the composer after a mid-attach failure (staged paste)", async () => {
    const term = fakeTerminal(0); // chip never appears → the paste stays staged, then times out
    const done = attachClaudeImages(term, ["/abs/a.png"], new AbortController().signal);
    const settled = expect(done).rejects.toMatchObject({ code: "image_attach_failed" });
    await vi.runAllTimersAsync();
    await settled;
    // The last write is the composer-clear (Ctrl+U + Ctrl+K), not left staged.
    expect(term.writes.at(-1)).toBe(`${String.fromCharCode(21)}${String.fromCharCode(11)}`);
  });

  test("C-API-45 holds the paste while a dialog is blocking, then sends once cleared", async () => {
    const term = fakeTerminal();
    let blocked = true;
    const done = attachClaudeImages(
      term,
      ["/abs/a.png"],
      new AbortController().signal,
      () => blocked,
    );
    // While blocked, nothing is written to the PTY.
    await vi.advanceTimersByTimeAsync(200);
    expect(term.writes).toHaveLength(0);
    blocked = false;
    await vi.runAllTimersAsync();
    await done;
    expect(term.writes).toHaveLength(1); // paste sent only after the dialog cleared
  });

  test("C-API-45 rejects when the signal is already aborted, pasting nothing", async () => {
    const term = fakeTerminal();
    const controller = new AbortController();
    controller.abort();
    await expect(attachClaudeImages(term, ["/abs/a.png"], controller.signal)).rejects.toMatchObject(
      { code: "image_attach_failed" },
    );
    expect(term.writes).toHaveLength(0);
  });

  test("C-API-45 rejects when aborted mid-wait after the first paste, then clears", async () => {
    const term = fakeTerminal(0);
    const controller = new AbortController();
    const done = attachClaudeImages(term, ["/abs/a.png"], controller.signal);
    const settled = expect(done).rejects.toMatchObject({ code: "image_attach_failed" });
    await vi.advanceTimersByTimeAsync(0); // reach the chip wait after the observed paste
    controller.abort();
    await vi.runAllTimersAsync();
    await settled;
    // The paste went out, then the failure cleared the composer.
    const clear = `${String.fromCharCode(21)}${String.fromCharCode(11)}`;
    expect(term.writes[0]?.startsWith(`${ESC}[200~`)).toBe(true);
    expect(term.writes.at(-1)).toBe(clear);
  });
});
