/**
 * Real-CLI verification that a caller-selected reasoning effort is ACCEPTED by the
 * live CLIs (PRD §5.1/§5.5, C-CLAUDE-20/C-CODEX-21). Elwood forwards Claude's
 * `--effort <level>` flag and Codex's `-c model_reasoning_effort=<value>` override;
 * this pins that the real binaries launch and reach ready with them, which a unit
 * test cannot prove (the flag/override only meets the real CLI here). The effort
 * itself is applied server-side and is not locally observable, so the assertion is
 * the honest one: the session reaches ready and completes a turn with effort set.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type ClaudeSessionApi,
  type CodexSessionApi,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import { cleanup, makeProject, skipReason, waitFor } from "./helpers.ts";

test("C-CLAUDE-20 Claude launches and reaches ready with --effort set (real CLI)", {
  skip: skipReason("claude"),
  timeout: 180_000,
}, async () => {
  const project = makeProject("claude");
  let session: ClaudeSessionApi | undefined;
  let stops = 0;
  try {
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      reasoningEffort: "high", // forwarded to Claude's --effort flag
      autotrust: true,
      hooks: {
        Stop: () => {
          stops += 1;
        },
      },
    });
    await waitFor(() => (session?.status === "ready" ? true : undefined), "claude ready", 60_000);
    // A real turn proves the session is genuinely usable with --effort applied, not
    // merely that it drew a composer.
    await session.sendMessage("Reply exactly: OK. Do not use tools.");
    await waitFor(() => (stops > 0 ? true : undefined), "claude turn Stop");
  } finally {
    await cleanup(session);
  }
});

test("C-CODEX-21 Codex launches and reaches ready with model_reasoning_effort set (real CLI)", {
  skip: skipReason("codex"),
  timeout: 180_000,
}, async () => {
  const project = makeProject("codex");
  let session: CodexSessionApi | undefined;
  try {
    session = await startCodex({
      cwd: project.cwd,
      stateDir: project.stateDir,
      reasoningEffort: "high", // forwarded as -c model_reasoning_effort="high"
      sandbox: "read-only",
      approvalPolicy: "never",
      autotrust: true,
    });
    await waitFor(() => (session?.status === "ready" ? true : undefined), "codex ready", 90_000);
    // The turn returning to `ready` proves the session is genuinely usable with the
    // effort override applied. This is the reliable Codex settle signal (mirrors
    // resume-ready-codex.e2e.ts) — a trivial turn does not necessarily fire a Stop hook.
    let running = false;
    session.on("status", (event) => {
      if (event.status === "running") running = true;
    });
    await session.sendMessage("Reply exactly: OK. Do not use tools.");
    await waitFor(() => (running ? true : undefined), "codex turn started", 90_000);
    await waitFor(
      () => (session?.status === "ready" ? true : undefined),
      "codex turn settled",
      90_000,
    );
    assert.ok(session, "codex session usable with reasoning effort set");
  } finally {
    await cleanup(session);
  }
});
