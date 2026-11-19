/** A wrapped footer releases the question hold at the frame's own width (C-CODEX-26, C-API-56). */
import { expect, test } from "vitest";
import { codexFooterCaptures170 } from "../../fixtures/codex-footer-captures-170.ts";
import { harness } from "./adapter-helpers.ts";
import { captured, frame } from "./helpers.ts";

/** Each wrapped capture at its own width, and at four times that width, which cut no row. */
const atWidths = codexFooterCaptures170
  .filter((capture) => capture.wrapped)
  .flatMap(({ rows, shape, cols }) => [
    { rows, shape, cols, held: false },
    { rows, shape, cols: cols * 4, held: true },
  ]);

test.each(
  atWidths,
)("C-CODEX-26 the empty composer after a question: $cols columns, held $held, $shape", ({
  rows,
  cols,
  held,
}) => {
  const h = harness();
  h.adapter.render(captured("async-badge.txt"));
  expect(h.adapter.blocksInput()).toBe(true);
  const composer = frame(rows.join("\n"));
  h.adapter.render({
    ...composer,
    cols,
    cursorX: 2,
    cursorRow: 0,
    cursorY: 0,
    cursorVisible: true,
  });
  expect(h.adapter.blocksInput()).toBe(held);
});
