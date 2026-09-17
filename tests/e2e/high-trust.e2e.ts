/**
 * Real-CLI verification of the agent-neutral `highTrust` switch (C-E2E-16 for
 * C-API-54 / C-CLAUDE-21): a Claude session started with `highTrust: true` reaches
 * `ready` in bypass-permissions mode with no acceptance dialog left on screen —
 * answering the one-time "WARNING: Claude Code running in Bypass Permissions mode"
 * dialog when the installed CLI renders it (2.1.268 on a Max account did NOT; see
 * docs/cli-behavior.md) — and a Codex session started with `highTrust: true`
 * reaches `ready` with the persisted posture `danger-full-access` / `never`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  type ClaudeSessionApi,
  type CodexSessionApi,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import { cleanup, makeProject, observeSession, skipIf, skipReason, waitFor } from "./helpers.ts";
import { trustPromptVisible } from "./trust-screens.ts";

type Launch = {
  readonly claude?: { readonly launch?: { readonly permissionMode?: string } };
  readonly codex?: {
    readonly launch?: { readonly sandbox?: string; readonly approvalPolicy?: string };
  };
};

function readRecord(stateDir: string, id: string): Launch {
  return JSON.parse(readFileSync(join(stateDir, "sessions", id, "session.json"), "utf8"));
}

function bypassDialogVisible(text: string): boolean {
  return /running in Bypass Permissions mode/i.test(text);
}

test("C-E2E-16 real Claude started with highTrust reaches ready in bypass-permissions mode", {
  skip: skipIf(skipReason("claude")),
  timeout: 180_000,
}, async () => {
  const project = makeProject("claude");
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      highTrust: true,
      autotrust: true,
    });
    const observed = observeSession(session);
    let dialogSeen = false;
    await waitFor(
      () => {
        const text = session?.terminal.snapshot().text ?? "";
        if (bypassDialogVisible(text)) dialogSeen = true;
        if (session?.status !== "ready") return undefined;
        // `ready` must never mask a still-visible trust-style dialog (C-CLAUDE-21).
        return trustPromptVisible(text, "claude") ? undefined : true;
      },
      "high-trust Claude ready with no trust dialog visible",
      120_000,
    );
    const text = session.terminal.snapshot().text;
    assert.equal(bypassDialogVisible(text), false, "no acceptance dialog is left on screen");
    assert.match(text, /bypass permissions on/i, "the CLI is running in bypass-permissions mode");
    assert.equal(
      readRecord(project.stateDir, session.elwoodSessionId).claude?.launch?.permissionMode,
      "bypassPermissions",
      "the persisted posture carries the expanded permission mode",
    );
    // Whether the installed CLI renders the one-time acceptance dialog is version- and
    // machine-dependent. When it does, Elwood must have answered it under its own label.
    const answered = observed.activities.filter((event) => {
      const activity = event as { readonly kind?: string; readonly label?: string };
      return activity.kind === "startup_prompt" && activity.label === "bypass_permissions";
    });
    console.log(
      `bypass-permissions acceptance dialog ${dialogSeen ? "rendered and was answered" : "did not render"} (claude ${answered.length} answer(s))`,
    );
    assert.equal(answered.length, dialogSeen ? 1 : 0, "dialog answered exactly when rendered");
    observed.dispose();
  } finally {
    await cleanup(session);
  }
});

test("C-E2E-16 real Codex started with highTrust reaches ready with danger-full-access", {
  skip: skipIf(skipReason("codex")),
  timeout: 180_000,
}, async () => {
  const project = makeProject("codex");
  let session: CodexSessionApi | undefined;
  try {
    session = await startCodex({
      cwd: project.cwd,
      stateDir: project.stateDir,
      highTrust: true,
      autotrust: true,
      hooks: {},
    });
    await waitFor(
      () =>
        session?.status === "ready" &&
        !trustPromptVisible(session.terminal.snapshot().text, "codex")
          ? true
          : undefined,
      "codex ready with no native trust dialog",
      90_000,
    );
    assert.deepEqual(
      readRecord(project.stateDir, session.elwoodSessionId).codex?.launch,
      { sandbox: "danger-full-access", approvalPolicy: "never" },
      "the persisted posture carries the expanded sandbox and approval policy",
    );
  } finally {
    await cleanup(session);
  }
});
