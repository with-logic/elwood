/** Retained provenance reuses completed rows and defers history work (C-CODEX-12). */
import { expect, test, vi } from "vitest";
import { CodexRetainedComposerHold } from "../../../src/codex/screen/retained-clearance.ts";
import { codexSmallComposer } from "../../fixtures/trust-composer.ts";

const update = "Update available! 0.151.0 -> 0.152.0";
const history = Array.from({ length: 200 }, (_, i) => `history ${i}   `).join("\n");

test("C-CODEX-12 ordinary repaints reuse snapshot rows without normalizing history", () => {
  let text = `${history}\n${codexSmallComposer}`;
  let frame = { text, lines: text.split("\n") };
  const hold = new CodexRetainedComposerHold(
    () => true,
    () => frame,
  );
  for (let repaint = 0; repaint < 20; repaint++) {
    text = `${repaint}\n${history}\n${codexSmallComposer}`;
    frame = { text, lines: text.split("\n") };
    const split = vi.spyOn(String.prototype, "split");
    const trim = vi.spyOn(String.prototype, "trimEnd");
    let splits: number;
    let trims: number;
    try {
      hold.observe(text, false);
      splits = split.mock.calls.length;
      trims = trim.mock.calls.length;
    } finally {
      split.mockRestore();
      trim.mockRestore();
    }
    expect(splits).toBe(0);
    expect(trims).toBeLessThan(10);
  }
  // The cached prior frame still fences a later replacement of equal size.
  hold.observe(`${update}\n${text}`, true);
  expect(hold.observe(text.replace("history 0", "foreign 0"), false)).toBe(true);
  expect(hold.observe(text, false)).toBe(false);
});

test("C-CODEX-12 a mismatched snapshot cannot vouch for observed text", () => {
  const text = codexSmallComposer;
  const hold = new CodexRetainedComposerHold(
    () => true,
    () => ({ text, lines: text.split("\n") }),
  );
  hold.observe(update, true);
  expect(hold.observe("unrelated partial frame", false)).toBe(true);
  expect(hold.observe(text, false)).toBe(false);
});
