/**
 * Real Claude model operations in short panes, at their default timeouts. Claude 2.1.332
 * sizes its model window to the pane, so below about 22 rows a window can hold a single
 * item; `listModels` and `setModel` walk those windows like any other. A failed operation
 * closes its own picker even in a layout Elwood cannot parse, so queued input is released
 * (C-API-23, C-API-24, C-API-55).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type AgentModelOption,
  type ClaudeSessionApi,
  ElwoodError,
  startClaude,
} from "../../src/index.ts";
import { rejectCompiledClaudeFallback } from "./claude-compiled-fallback.ts";
import {
  bogusClaudeModel,
  cleanup,
  hookNamed,
  makeProject,
  observeSession,
  skipIf,
  skipReason,
  waitFor,
} from "./helpers.ts";

/** Starts Claude at 100x30; `onStarted` gets the session before readiness, so cleanup has it. */
async function startTall(
  onStarted: (session: ClaudeSessionApi) => void,
  model?: string,
): Promise<ClaudeSessionApi> {
  const project = makeProject("claude");
  // Thirty rows fit the folder-trust dialog that autotrust answers in this fresh folder.
  const session = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    autotrust: true,
    initialSize: { cols: 100, rows: 30 },
    ...(model === undefined ? {} : { model }),
  });
  onStarted(session);
  await waitFor(() => (session.status === "ready" ? true : undefined), "claude ready", 90_000);
  return session;
}

/** Every listed row in picker order, null ids and the current model included (C-API-23). */
const listing = (models: readonly Pick<AgentModelOption, "id" | "label" | "isCurrent">[]) =>
  models.map(({ id, label, isCurrent }) => ({ id, label, isCurrent }));

test("C-API-23 C-API-24 listModels and setModel walk Claude's one-item windows in short panes", {
  skip: skipIf(skipReason("claude")),
  timeout: 240_000,
}, async () => {
  let session: ClaudeSessionApi | undefined;
  try {
    const live = await startTall((started) => {
      session = started;
    });
    // The served catalog, not the compiled five-row fallback, and more than a window shows.
    const baseline = rejectCompiledClaudeFallback(await live.listModels());
    assert.ok(baseline.length > 2, "more models than a short pane's window holds");
    // The last rows sit behind `More models`, so reaching them walks every window.
    const [first, second] = baseline.flatMap((model) => model.id ?? []).slice(-2);
    assert.ok(first !== undefined && second !== undefined, "two models behind the disclosure");
    for (const [rows, target] of [
      [21, first],
      [12, second],
    ] as const) {
      await live.resize({ cols: 100, rows: 30 });
      const tall = listing(await live.listModels());
      await live.resize({ cols: 100, rows });
      assert.deepEqual(listing(await live.listModels()), tall, `listModels at 100x${rows}`);
      // The walk changed nothing: listing again still finds the same current model.
      assert.deepEqual(listing(await live.listModels()), tall, `relisting at 100x${rows}`);
      await live.setModel(target);
      const current = (await live.listModels()).find((model) => model.isCurrent);
      assert.equal(current?.id, target, `setModel at 100x${rows}`);
    }
  } finally {
    await cleanup(session);
  }
});

test("C-API-55 a failed operation closes its own unparsed picker and releases queued input", {
  skip: skipIf(skipReason("claude")),
  timeout: 240_000,
}, async () => {
  let session: ClaudeSessionApi | undefined;
  try {
    // A bogus model refuses the turn below before any model quota is used.
    const live = await startTall((started) => {
      session = started;
    }, bogusClaudeModel);
    const observed = observeSession(live);
    const screen = () => live.terminal.snapshot().text;
    // At 100x10 the picker's hint row falls below the pane, so no grammar parses it.
    await live.resize({ cols: 100, rows: 10 });
    const listed = live.listModels();
    const rejected = assert.rejects(listed, (error) => {
      assert.ok(error instanceof ElwoodError);
      assert.equal(error.code, "model_automation_failed");
      assert.match(error.message, /model picker was open in a layout Elwood could not parse/);
      return true;
    });
    await waitFor(
      () => (/Select model/.test(screen()) && !/Esc to cancel/.test(screen()) ? true : undefined),
      "the footer-cut picker",
      20_000,
    );
    await rejected;
    await waitFor(
      () => (/Select model/.test(screen()) ? undefined : true),
      "the picker closed by cleanup",
      10_000,
    );
    // Still at 100x10: the release needs no taller pane.
    const before = observed.hooks.length;
    await live.sendMessage("Reply with exactly OK.");
    await waitFor(
      () => hookNamed(observed.hooks.slice(before), "UserPromptSubmit"),
      "the queued message submitted",
      30_000,
    );
  } finally {
    await cleanup(session);
  }
});
