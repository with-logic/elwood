/**
 * Real-CLI verification that a Codex exec turn surfaces the BARE command and its
 * output as a clean paired tool_call / tool_result (PRD §5.4/§7A.4, C-CODEX-19).
 * The modern `exec` tool wraps the command in a JS `tools.exec_command({...})`
 * snippet; Elwood must unwrap it so consumers see `echo …`, not the harness.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type CodexSession, startCodex } from "../../src/index.ts";
import {
  cleanup,
  e2eTimeoutMs,
  makeProject,
  observeSession,
  skipReason,
  turnsEnabled,
  waitFor,
} from "./helpers.ts";

const skipTurnsReason = turnsEnabled ? undefined : "ELWOOD_E2E_SKIP_TURNS=1 disables turn flows";
const MARKER = "ELWOOD_EXEC_MARKER_9f3";

type Activity = {
  readonly kind?: string;
  readonly label?: string;
  readonly toolInput?: string;
  readonly toolOutput?: string;
};

test("C-CODEX-19 real Codex exec surfaces the bare command and output (unwrapped)", {
  skip: skipReason("codex") ?? skipTurnsReason,
  timeout: e2eTimeoutMs + 60_000,
}, async () => {
  const project = makeProject("codex");
  let session: CodexSession | undefined;
  try {
    session = await startCodex({
      cwd: project.cwd,
      stateDir: project.stateDir,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      autotrust: true,
      hooks: {},
    });
    const observed = observeSession(session);
    await waitFor(() => (session?.status === "ready" ? true : undefined), "codex ready", 60_000);
    await session.sendMessage(`Run exactly this shell command and nothing else: echo ${MARKER}`);
    // Wait for a tool_call whose input is the BARE command — not the JS wrapper.
    const call = await waitFor(
      () =>
        (observed.activities as Activity[]).find(
          (a) => a.kind === "tool_call" && a.toolInput?.includes(`echo ${MARKER}`),
        ),
      "exec tool_call with the bare command",
      120_000,
    );
    // The unwrap is the whole point: the JS harness must NOT leak into toolInput.
    assert.ok(!call.toolInput?.includes("tools.exec_command"), "JS wrapper is stripped");
    assert.ok(!call.toolInput?.includes("yield_time_ms"), "harness fields are stripped");
    // The paired tool_result carries the command's stdout.
    const result = await waitFor(
      () =>
        (observed.activities as Activity[]).find(
          (a) => a.kind === "tool_result" && a.toolOutput?.includes(MARKER),
        ),
      "exec tool_result with the command output",
      60_000,
    );
    assert.ok(result.toolOutput?.includes(MARKER), "output carries the echoed marker");
    observed.dispose();
  } finally {
    await cleanup(session);
  }
});
