/**
 * Real-CLI verification of the agent-neutral `highTrust` switch (C-E2E-16 for
 * C-API-54 / C-CLAUDE-21): a Claude session started with `highTrust: true` answers the
 * one-time "WARNING: Claude Code running in Bypass Permissions mode" dialog and reaches
 * `ready` in bypass-permissions mode with no acceptance dialog left on screen. The
 * suite's private Claude config (`claude-home.ts`) has never accepted the dialog and
 * has no `skipDangerousModePermissionPrompt` setting, so the CLI always renders it
 * (docs/cli-behavior.md). The PTY's writes are recorded from spawn, so the answer is
 * proven even if it came before `startClaude` resolved and anyone could subscribe. A
 * Codex session started with `highTrust: true` reaches `ready` with the persisted
 * posture `danger-full-access` / `never`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { codexTrustClearance } from "../../src/codex/screen-table.ts";
import { trustView } from "../../src/core/trust/view.ts";
import {
  type ClaudeSessionApi,
  type CodexSessionApi,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { resetRuntimeSeamsForTests, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
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

/** Every write to a real PTY spawned from now on, with its time. */
function recordPtyWrites(): readonly { readonly at: number; readonly data: string }[] {
  const writes: { at: number; data: string }[] = [];
  setPtyFactoryForTests((options) => {
    const pty = nodePtyFactory(options);
    return {
      ...pty,
      write(data) {
        writes.push({ at: Date.now(), data: Buffer.from(data).toString("utf8") });
        pty.write(data);
      },
    };
  });
  return writes;
}

// The bypass dialog opens on `No, exit`: Elwood moves to `Yes, I accept`, then confirms it.
const selectAccept = "\u001b[H\u001b[B";

test("C-E2E-16 real Claude started with highTrust reaches ready in bypass-permissions mode", {
  skip: skipIf(skipReason("claude")),
  timeout: 180_000,
}, async () => {
  const project = makeProject("claude");
  let session: ClaudeSessionApi | undefined;
  const writes = recordPtyWrites();
  try {
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      highTrust: true,
      autotrust: true,
    });
    const subscribedAt = Date.now();
    const observed = observeSession(session);
    await waitFor(
      () => {
        const text = session?.terminal.snapshot().text ?? "";
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
    // The dialog renders in the private config, and Elwood answers it once. It can clear
    // between two polls of the screen, so the PTY's writes are the evidence.
    const confirms = writes.filter(({ data }) => data === `${selectAccept}\r`);
    assert.equal(confirms.length, 1, "Elwood confirmed Yes, I accept once");
    // The live `startup_prompt` activity fires with the answer's first write, so an
    // observer subscribed after start sees it whenever that write came later.
    const answeredAt = writes.find(({ data }) => data === selectAccept)?.at ?? 0;
    const answered = observed.activities.filter((event) => {
      const activity = event as { readonly kind?: string; readonly label?: string };
      return activity.kind === "startup_prompt" && activity.label === "bypass_permissions";
    });
    assert.equal(answered.length, answeredAt >= subscribedAt ? 1 : 0, "answer activity, live");
    observed.dispose();
  } finally {
    resetRuntimeSeamsForTests();
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
    await session.resize({ cols: 100, rows: 6 });
    const compact = await waitFor(
      () => {
        const frame = session!.terminal.snapshot().text;
        return !frame.includes("OpenAI Codex") &&
          /^\s*›/m.test(frame) &&
          /^\s+\S+ \S+ · \//m.test(frame)
          ? frame
          : undefined;
      },
      "native composer after welcome scrolls offscreen",
      10_000,
    );
    assert.equal(trustView(compact, "codex", codexTrustClearance).kind, "clear");
  } finally {
    await cleanup(session);
  }
});
