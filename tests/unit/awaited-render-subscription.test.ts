/** Real terminal completion wakes awaited composer observation (PRD §5.3, C-API-31). */
import { expect, test } from "vitest";
import { preparePasteNudges } from "../../src/core/input/paste-nudge.ts";
import {
  captureRenderProgress,
  currentRenderedFrame,
  subscribeRender,
} from "../../src/terminal/cursor.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

test("C-API-31 completed output immediately releases awaited input and removes its listener", async () => {
  const terminal = createHeadlessTerminal({ cols: 40, rows: 8 }, () => undefined);
  const cancel = new AbortController();
  let observations = 0;
  const guard = {
    captureRenderProgress: () => captureRenderProgress(terminal),
    subscribeRender: (listener: () => void) => subscribeRender(terminal, listener),
    prepareStaged: () => () => false,
    emptyFrame: () => {
      observations += 1;
      return currentRenderedFrame(terminal);
    },
  };
  await terminal.writeOutput("before");
  const prior = guard.emptyFrame();
  const nudges = preparePasteNudges(terminal, guard, "", cancel.signal, 60_000, prior);
  nudges?.beforeEnter();
  const accepted = nudges?.awaitEmptyInput();
  try {
    await terminal.writeOutput("\r\nafter");
    await expect(accepted).resolves.toBe(true);
    const count = observations;
    await terminal.writeOutput("\r\nlater");
    expect(observations).toBe(count);
  } finally {
    cancel.abort();
    terminal.dispose();
  }
});

test("C-API-31 retired terminals cannot publish completion notifications", async () => {
  const terminal = createHeadlessTerminal({ cols: 40, rows: 8 }, () => undefined);
  let calls = 0;
  const off = subscribeRender(terminal, () => {
    calls += 1;
  });
  terminal.dispose();
  off();
  const absent = subscribeRender(terminal, () => {
    calls += 1;
  });
  await terminal.writeOutput("ignored");
  absent();
  expect(calls).toBe(0);
});
