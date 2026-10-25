/**
 * A real bypass-permissions Claude session whose version banner has scrolled away still
 * reads as Claude's own idle composer, by its permission-mode footer alone.
 * Implements C-TRUST-01, C-API-55 and C-API-56.
 *
 * The checks run Elwood's composer predicates on the live session's rendered frames rather
 * than through a held write. On Claude Code 2.1.310 the hand-opened picker is not yet
 * recognized as a foreign dialog (its `● High effort` row and scroll markers fall outside
 * the dialog grammar), so no hold engages on it to stall a queued write. Asserting on the
 * frame proves the footer fix against the real CLI either way.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { claudeEmptyInputFrame } from "../../src/claude/composer/empty-input.ts";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { claudeTrustClearance, liveClaudeClearance } from "../../src/claude/screen-table.ts";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { cleanup, makeProject, skipIf, skipReason, waitFor } from "./helpers.ts";

const banner = /Claude Code v[\d.]+/;
const bypassFooter = /^\s*(?:-- INSERT -- )?⏵⏵ bypass permissions on \(shift\+tab to cycle\)/m;

test("C-TRUST-01 C-API-55 a bannerless bypass-permissions composer is recognized as idle", {
  skip: skipIf(skipReason("claude")),
  timeout: 240_000,
}, async () => {
  const project = makeProject("claude");
  let session: ClaudeSessionApi | undefined;
  try {
    // Thirty rows fit the folder-trust dialog that autotrust answers in this fresh folder.
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      autotrust: true,
      permissionMode: "bypassPermissions",
      initialSize: { cols: 100, rows: 30 },
    });
    const live = session;
    const screen = () => live.terminal.snapshot().text;
    const bannerless = (label: string) =>
      waitFor(
        () => {
          const text = screen();
          return !banner.test(text) && bypassFooter.test(text) ? text : undefined;
        },
        label,
        30_000,
      );
    await waitFor(() => (live.status === "ready" ? true : undefined), "claude ready", 90_000);

    // Eight rows hold only the rules, composer and footer: the banner leaves the viewport.
    await live.resize({ cols: 100, rows: 8 });
    const startup = await bannerless("bannerless startup composer");
    assert.equal(claudeTrustClearance(startup), true, "trust clearance without the banner");
    await waitFor(
      () => (liveClaudeClearance(() => live.terminal)(screen()) ? true : undefined),
      "live trust clearance on the bannerless composer",
      10_000,
    );
    await waitFor(
      () => (claudeEmptyInputFrame(live.terminal) ? true : undefined),
      "native empty input on the bannerless composer",
      10_000,
    );

    // A human opens the picker through raw keys and closes it with Escape.
    await live.resize({ cols: 100, rows: 12 });
    await live.sendKeys("/model");
    await delay(400);
    await live.sendKeys("\r");
    await waitFor(
      () => (/Select model/.test(screen()) ? true : undefined),
      "hand-opened model picker",
      30_000,
    );
    await live.sendKeys("\u001b");
    await waitFor(
      () => (/Kept model as/.test(screen()) && !/Select model/.test(screen()) ? true : undefined),
      "model picker closed by Escape",
      30_000,
    );
    const closed = await bannerless("bannerless composer after the picker");
    assert.equal(claudeModelPicker.isClear(closed), true, "the picker hold's release evidence");
    await waitFor(
      () =>
        liveClaudeClearance(() => live.terminal, claudeModelPicker.isClear)(screen())
          ? true
          : undefined,
      "live picker clearance on the bannerless composer",
      10_000,
    );
    const models = await live.listModels({ timeoutMs: 30_000 });
    assert.ok(models.length >= 1, "listModels runs after the hand-opened picker");
  } finally {
    await cleanup(session);
  }
});
