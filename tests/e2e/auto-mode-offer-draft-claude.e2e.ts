/**
 * Claude's side of a paste that its auto-mode offer paints over: after Elwood declines the
 * offer, the composer still holds the draft in the shape Elwood's staged-composer clearance
 * reads, and Enter submits it. Elwood's held Enter is covered by
 * `tests/claude/session-auto-mode-offer-staged.test.ts`, because the race that stages
 * Elwood's own paste under the offer cannot be timed on the real CLI.
 * Implements C-ATTN-09 (PRD §5.3) and C-CLAUDE-26 (PRD §5.1).
 */

import test from "node:test";
import { isClaudeAutoModeOffer } from "../../src/claude/auto-mode-offer.ts";
import { claudeStagedComposerClearance } from "../../src/claude/composer/staged-input.ts";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { offerSessionOptions, offerShown, seedOffer } from "./auto-mode-offer.ts";
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

test("C-ATTN-09 Claude keeps a draft the offer painted over in the composer shape Elwood clears on", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: 240_000,
}, async (t) => {
  seedOffer();
  const project = makeProject("claude");
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude(offerSessionOptions(project, "Offer Draft"));
    const live = session;
    const observed = observeSession(live);
    const screen = () => live.terminal.snapshot().text;
    await waitFor(() => (live.status === "ready" ? true : undefined), "initial ready", 120_000);
    await live.sendMessage("Count from 1 to 40, one number per line. No tools.");
    // `sendMessage` resolves once its Enter is written, while Claude can still show the prompt
    // in its composer. A paste typed then was once gone by the time the offer closed, so wait
    // until Claude has taken the prompt and shows the turn working.
    await waitFor(() => hookNamed(observed.hooks, "UserPromptSubmit"), "prompt submitted", 30_000);
    await waitFor(
      () => (screen().includes("esc to interrupt") ? true : undefined),
      "turn working",
      30_000,
    );
    // A multi-line paste typed during the turn: Claude shows it as a pill and keeps it staged.
    const marker = `zq${Date.now().toString(36)}`;
    const draft = [`Check ${marker}: line one.`, "Line two.", "Line three.", "Reply with OK."];
    await live.sendKeys(`\u001b[200~${draft.join("\n")}\u001b[201~`);
    await waitFor(() => hookNamed(observed.hooks, "Stop"), "turn Stop", 90_000);
    if (!(await offerShown(live))) {
      skipNow(t, `Claude did not offer auto-mode setup over the draft:\n${screen()}`);
      return;
    }

    // The paste was typed before the offer appeared, so Elwood declines the offer.
    await waitFor(
      () => (isClaudeAutoModeOffer(screen()) ? undefined : true),
      "Elwood's decline",
      15_000,
    );
    const staged = claudeStagedComposerClearance(() => live.terminal);
    await waitFor(() => (staged(screen()) ? true : undefined), "staged composer", 15_000).catch(
      (error: unknown) => {
        throw new Error(`No verified composer holding the draft:\n${screen()}`, { cause: error });
      },
    );
    const hooksBefore = observed.hooks.length;
    await live.sendKeys("\r");
    await waitFor(
      () =>
        observed.hooks
          .slice(hooksBefore)
          .some(
            (hook) => hook.hook_event_name === "UserPromptSubmit" && hook.prompt.includes(marker),
          )
          ? true
          : undefined,
      "the draft submitted",
      30_000,
    );
    observed.dispose();
  } finally {
    await cleanup(session);
  }
});
