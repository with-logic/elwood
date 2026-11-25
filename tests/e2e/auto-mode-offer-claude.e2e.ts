/**
 * Claude's auto-mode setup offer, which Claude paints right after a turn's Stop above a
 * composer that stays visible, blocks a named session. A caller's `sendMessage` made while
 * it is visible is held instead of answering it, then submits once the offer is dismissed.
 * Implements C-ATTN-09 (PRD §5.3).
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "../../src/core/predicates.ts";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { defaultClaudeConfigDir } from "./claude-home.ts";
import {
  cleanup,
  hookNamed,
  makeProject,
  observeSession,
  skipIf,
  skipNow,
  skipReason,
  skipTurns,
  waitFor,
} from "./helpers.ts";

const offerTitle = "Teach auto mode about your environment?";
/** Long enough that a held message would have resolved (paste, 150 ms, Enter) had it gone out. */
const heldWindowMs = 3_000;

/**
 * Claude 2.1.332 offers setup after a turn in auto mode once it has started five times and
 * auto mode has denied five actions. It does not offer it once setup has saved an
 * environment, after "Don't show again" (`dismissed`), or within 7 days of an Esc
 * (`dismissedAt`); see `docs/cli-behavior.md`. Seed this process's private config, and
 * replace `autoModeEnvSetup` outright so that an earlier test's dismissal is cleared too.
 */
function seedOffer(): void {
  const path = join(defaultClaudeConfigDir, ".claude.json");
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(config)) throw new Error(`${path} does not hold a JSON object`);
  const prior = config["numStartups"];
  const numStartups = Math.max(typeof prior === "number" ? prior : 0, 5);
  const seeded = { ...config, numStartups, autoModeEnvSetup: { denials: 5 } };
  writeFileSync(path, JSON.stringify(seeded), { mode: 0o600 });
}

/** A multi-line prompt of a few hundred characters, which Claude shows as a pasted pill. */
function reportShapedPrompt(marker: string): string {
  const filler = (n: number) =>
    `Line ${n} carries ordinary filler words so that the prompt has a realistic length.`;
  return [
    `Check ${marker}: please read all of these lines.`,
    filler(2),
    filler(3),
    filler(4),
    filler(5),
    "Reply with exactly OK and nothing else. Do not use tools.",
  ].join("\n");
}

test("C-ATTN-09 a sendMessage made while Claude's auto-mode offer shows is held, not lost", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: 240_000,
}, async (t) => {
  seedOffer();
  const project = makeProject("claude");
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      autotrust: true,
      autoupdate: false,
      name: "Offer Check",
      model: "haiku",
      permissionMode: "auto",
      initialSize: { cols: 140, rows: 40 },
    });
    const live = session;
    const observed = observeSession(live);
    const screen = () => live.terminal.snapshot().text;
    await waitFor(() => (live.status === "ready" ? true : undefined), "initial ready", 120_000);
    await live.sendMessage("Reply with exactly OK.");
    await waitFor(() => hookNamed(observed.hooks, "Stop"), "first turn Stop", 90_000);
    try {
      await waitFor(() => (screen().includes(offerTitle) ? true : undefined), "offer", 15_000);
    } catch {
      assert.notEqual(live.status, "exited", `Claude exited instead:\n${screen()}`);
      skipNow(t, `Claude did not offer auto-mode setup on this account:\n${screen()}`);
      return;
    }

    const marker = `zq${Date.now().toString(36)}`;
    const hooksBefore = observed.hooks.length;
    const submitted = () =>
      observed.hooks
        .slice(hooksBefore)
        .some(
          (hook) => hook.hook_event_name === "UserPromptSubmit" && hook.prompt.includes(marker),
        );
    let resolved = false;
    const sending = live.sendMessage(reportShapedPrompt(marker)).then(() => {
      resolved = true;
    });
    // Teardown rejects a still-held send if an assertion below fails first.
    void sending.catch(() => undefined);
    await delay(heldWindowMs);
    assert.equal(resolved, false, `the message was written into the offer:\n${screen()}`);
    assert.match(screen(), /❯ 1\. Yes/, "the offer's menu is unanswered");
    assert.doesNotMatch(screen(), /Space to toggle/, "no setup step opened");
    assert.equal(live.status, "blocked");
    assert.ok(
      observed.activities.some(
        (event) => event.kind === "attention" && event.label === "claude-auto-mode-offer",
      ),
      "the block names the offer rule",
    );

    // Dismissing the offer releases the held message as a normal turn.
    await live.sendKeys("\u001b");
    await sending;
    await waitFor(() => (submitted() ? true : undefined), "held message submitted", 30_000);
    await waitFor(
      () => hookNamed(observed.hooks.slice(hooksBefore), "Stop"),
      "held message turn Stop",
      90_000,
    );
    observed.dispose();
  } finally {
    await cleanup(session);
  }
});
