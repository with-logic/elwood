/**
 * Real Claude and Codex TUI intervention coverage for state-aware guidance.
 * Implements C-API-37, C-API-62, C-E2E-02, and C-E2E-03. Consumption is asserted via the
 * signals the CLIs actually provide for MID-TURN steering — the guidance overtakes
 * readiness (no intervening `ready`), `sendGuidance` resolves after the submitting
 * Enter, the marker renders in the live TUI, AND the marker is no longer sitting on
 * the composer prompt line (proving it was SUBMITTED, not merely pasted — a
 * regression that omits the submitting Enter would leave it staged in the composer).
 * Claude Code 2.1.332 fires `UserPromptSubmit` when it queues the guidance, with the
 * running turn's prompt ID, so the Claude case also requires the guidance's own
 * `user_message`. The Codex case does not require a hook.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type ElwoodAgentSession,
  type ElwoodSessionStatus,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import { cleanup, makeProject, skipIf, skipReason, skipTurns, waitFor } from "./helpers.ts";

type GuidanceOutcome = {
  // Status transitions observed from the moment guidance was sent until it
  // settled. A guidance that BYPASSED readiness settles into the live running
  // turn without an intervening `ready` transition; one that waited for the turn
  // to finish would show a `ready` transition first.
  readonly transitionsDuringGuidance: readonly ElwoodSessionStatus[];
  readonly status: ElwoodSessionStatus;
  readonly screen: string;
};

/**
 * True if the marker is still sitting UNSUBMITTED in the composer: the LAST prompt-glyph
 * line. Earlier glyph lines are not the composer: Claude 2.1.310 shows a message submitted
 * during a turn as a queued `❯ <message>` row above it, with `ctrl+x ctrl+s to send now`
 * beneath, while the composer reads `❯ Press up to edit queued messages`.
 */
function markerStuckInComposer(text: string, glyph: string, marker: string): boolean {
  const glyphLines = text
    .split("\n")
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith(glyph));
  return glyphLines.at(-1)?.includes(marker) ?? false;
}

async function guidanceFlow(
  session: ElwoodAgentSession,
  marker: string,
  composerGlyph: string,
): Promise<GuidanceOutcome> {
  await waitFor(() => (session.status === "ready" ? true : undefined), "initial ready", 60_000);
  await session.sendMessage(
    "Write a detailed 2,000-word essay about terminal history. Do not use tools.",
  );
  await waitFor(
    () => (/esc to interrupt/i.test(session.terminal.snapshot().text) ? true : undefined),
    "turn visibly running",
    60_000,
  );
  // Record status transitions across the guidance send. A `ready` transition would
  // mean guidance waited for the turn to finish; C-API-37 requires it to overtake
  // readiness and enter the TUI immediately, so no `ready` may intervene.
  const transitionsDuringGuidance: ElwoodSessionStatus[] = [];
  const offStatus = session.on("status", (event) => transitionsDuringGuidance.push(event.status));
  try {
    // `sendGuidance` resolves only after the submitting Enter is dispatched into the
    // live TUI (the C-API-37 contract, and the signal both CLIs share). Only the Claude
    // case also requires a hook: Claude 2.1.332 fires `UserPromptSubmit` as it queues it.
    await session.sendGuidance(`Coordinator intervention: stop the essay. Marker: ${marker}`);
  } finally {
    offStatus();
  }
  const status = session.status;
  // The submitting Enter has landed; poll for the marker to render in the live TUI.
  const screen = await waitFor(
    () => {
      const text = session.terminal.snapshot().text;
      return text.includes(marker) ? text : undefined;
    },
    "guidance marker on screen",
    30_000,
  );
  // Prove SUBMISSION, not mere rendering: a regression that pastes the marker but
  // omits the submitting Enter leaves it sitting on the composer prompt line. After a
  // real submit the composer is cleared, so the marker must NOT remain in it — screen
  // echo alone (asserted above) cannot distinguish pasted-but-not-sent.
  await waitFor(
    () =>
      markerStuckInComposer(session.terminal.snapshot().text, composerGlyph, marker)
        ? undefined
        : true,
    "guidance marker submitted (composer cleared, not left staged)",
    30_000,
  );
  return { transitionsDuringGuidance, status, screen };
}

test("C-API-37 C-API-62 real Claude receives guidance during an active turn and shows it once", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: 240_000,
}, async () => {
  const project = makeProject("claude");
  const session = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    permissionMode: "bypassPermissions",
    autotrust: true,
    hooks: {},
  });
  const userMessages: string[] = [];
  session.on("activity", (event) => {
    if (event.kind === "user_message" && event.source === "hook") userMessages.push(event.text);
  });
  try {
    const outcome = await guidanceFlow(session, "ELWOOD_GUIDANCE_CLAUDE_NOW", "❯");
    const guidanceMessages = () =>
      userMessages.filter((text) => text.includes("ELWOOD_GUIDANCE_CLAUDE_NOW")).length;
    await waitFor(
      () => guidanceMessages() > 0 || undefined,
      "the guidance's own user_message, though Claude reuses the running turn's prompt ID",
      30_000,
    );
    // Claude runs the queued guidance as a new turn after the essay's Stop. Wait until both
    // turns are done, so a second hook at that point would be counted.
    let idleSince: number | undefined;
    await waitFor(
      () => {
        if (/esc to interrupt/i.test(session.terminal.snapshot().text)) idleSince = undefined;
        else idleSince ??= Date.now();
        return idleSince !== undefined && Date.now() - idleSince >= 3_000 ? true : undefined;
      },
      "Claude to finish the essay and the queued guidance",
      180_000,
    );
    assert.equal(
      guidanceMessages(),
      1,
      `one guidance, one message: ${JSON.stringify(userMessages)}`,
    );
    assert.ok(
      !outcome.transitionsDuringGuidance.includes("ready"),
      "guidance settled into the live running turn without waiting for a ready transition",
    );
    assert.equal(outcome.status, "running", "the original turn was still active");
    assert.match(outcome.screen, /ELWOOD_GUIDANCE_CLAUDE_NOW/, "live TUI received the guidance");
  } finally {
    await cleanup(session);
  }
});

test("C-API-37 real Codex receives guidance during an active turn", {
  skip: skipIf(skipReason("codex"), skipTurns),
  timeout: 120_000,
}, async () => {
  const project = makeProject("codex");
  const session = await startCodex({
    cwd: project.cwd,
    stateDir: project.stateDir,
    sandbox: "read-only",
    approvalPolicy: "never",
    autotrust: true,
    hooks: {},
  });
  try {
    const outcome = await guidanceFlow(session, "ELWOOD_GUIDANCE_CODEX_NOW", "›");
    assert.ok(
      !outcome.transitionsDuringGuidance.includes("ready"),
      "guidance settled into the live running turn without waiting for a ready transition",
    );
    assert.equal(outcome.status, "running", "the original turn was still active");
    assert.match(outcome.screen, /ELWOOD_GUIDANCE_CODEX_NOW/, "live TUI received the guidance");
  } finally {
    await cleanup(session);
  }
});
