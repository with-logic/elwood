/**
 * Real Claude model operations in short panes. Claude 2.1.332 sizes its model window to
 * the pane, so below about 22 rows a window can hold a single model row; `listModels` and
 * `setModel` walk those windows like any other. A failed operation closes its own picker
 * even in a layout Elwood cannot parse, so queued input is released (C-API-23, C-API-24,
 * C-API-55).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type ClaudeSessionApi, ElwoodError, startClaude } from "../../src/index.ts";
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

const timeouts = { timeoutMs: 30_000 } as const;

async function startTall(model?: string): Promise<ClaudeSessionApi> {
  const project = makeProject("claude");
  // Thirty rows fit the folder-trust dialog that autotrust answers in this fresh folder.
  const session = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    autotrust: true,
    initialSize: { cols: 100, rows: 30 },
    ...(model === undefined ? {} : { model }),
  });
  await waitFor(() => (session.status === "ready" ? true : undefined), "claude ready", 90_000);
  return session;
}

const ids = (models: readonly { readonly id: string | null }[]) =>
  models.flatMap((model) => (model.id === null ? [] : [model.id])).sort();

test("C-API-23 C-API-24 listModels and setModel walk Claude's one-row windows in short panes", {
  skip: skipIf(skipReason("claude")),
  timeout: 240_000,
}, async () => {
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startTall();
    const live = session;
    const tall = await live.listModels(timeouts);
    // The last rows sit behind `More models`, so reaching them walks every window.
    const targets = tall.flatMap((model) => model.id ?? []).slice(-2);
    assert.equal(targets.length, 2, "two models behind the disclosure");
    for (const [rows, target] of [
      [21, targets[0]],
      [12, targets[1]],
    ] as const) {
      await live.resize({ cols: 100, rows });
      assert.deepEqual(
        ids(await live.listModels(timeouts)),
        ids(tall),
        `listModels at 100x${rows}`,
      );
      await live.setModel(target as string, timeouts);
      const current = (await live.listModels(timeouts)).find((model) => model.isCurrent);
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
    session = await startTall(bogusClaudeModel);
    const live = session;
    const observed = observeSession(live);
    const screen = () => live.terminal.snapshot().text;
    // At 100x10 the picker's hint row falls below the pane, so no grammar parses it.
    await live.resize({ cols: 100, rows: 10 });
    await assert.rejects(live.listModels({ timeoutMs: 15_000 }), (error) => {
      assert.ok(error instanceof ElwoodError);
      assert.equal(error.code, "model_automation_failed");
      return true;
    });
    await waitFor(
      () => (/Select model/.test(screen()) ? undefined : true),
      "the picker closed by cleanup",
      10_000,
    );
    await live.resize({ cols: 100, rows: 12 });
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
