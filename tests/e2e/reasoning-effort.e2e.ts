/**
 * Real-CLI reasoning-effort configuration (PRD §5.1/§5.5, C-CLAUDE-20/C-CODEX-21).
 * Elwood forwards Claude's `--effort` flag and Codex's model_reasoning_effort override.
 * The ultra case checks native composer configuration without a model turn; the high
 * cases also complete a turn to exercise provider acceptance, which a local footer
 * alone cannot establish.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, parseVersion } from "../../src/core/versions.ts";
import {
  type ClaudeSessionApi,
  type CodexSessionApi,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { probeShellCommand, userShell } from "../../src/runtime/shell.ts";
import { pathSkipReason } from "./availability.ts";
import { codexLaunches, runCodexTest } from "./codex-test-end.ts";
import {
  cleanup,
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipNow,
  skipReason,
  waitFor,
} from "./helpers.ts";

const minimumUltraCodexVersion = "0.169.0";

test("C-CODEX-21 C-API-28 Codex launches with ultra effort and a configured composer", {
  skip: skipIf(pathSkipReason("codex"), codexAuthMissing()),
  timeout: 90_000,
}, async (t) => {
  const result = await runProbe(userShell(), probeShellCommand("codex --version", "codex"));
  assert.equal(result.status, 0, "Codex version probe succeeds");
  const version = parseVersion(result.stdout);
  assert.ok(version, "Codex reports its native CLI version");
  if (compareVersions(version, minimumUltraCodexVersion) < 0) {
    skipNow(t, `The ultra composer probe requires Codex ${minimumUltraCodexVersion} or newer`);
    return;
  }
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, 'model_reasoning_effort = "medium"\n');
  const launches = codexLaunches();
  let session: CodexSessionApi | undefined;
  await runCodexTest({ sessions: () => [session], sandbox, launches }, async () => {
    session = await launches.track(
      startCodex({
        ...project,
        model: "gpt-6.2-sol",
        reasoningEffort: "ultra",
        sandbox: "read-only",
        approvalPolicy: "never",
        autotrust: true,
        hooks: {},
      }),
    );
    await session.waitForStatus((status) => status === "ready", 60_000);
    assert.match(session.terminal.snapshot().text, /(?:gpt|GPT)-[\w.-]+(?: Terra)? ultra/);
    // Native configuration evidence only: opening the CLI runs no model turn.
  });
});

test("C-CLAUDE-20 Claude launches and reaches ready with --effort set (real CLI)", {
  skip: skipIf(skipReason("claude")),
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
  skip: skipIf(skipReason("codex")),
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
