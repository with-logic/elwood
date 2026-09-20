/** Real production cursor/PTY trust recovery with queued input (C-E2E-09, C-TRUST-01). */
import assert from "node:assert/strict";
import test from "node:test";
import { liveCodexClearance } from "../../src/codex/screen/live-clearance.ts";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { settledCursorVisible } from "../../src/terminal/cursor.ts";
import {
  cleanup,
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
  waitFor,
} from "./helpers.ts";

test("C-E2E-09 production Codex holds queued input through human trust and native cursor clearance", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: 90_000,
}, async (t) => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, "check_for_update_on_startup = false\n");
  let session: CodexSessionApi | undefined;
  t.after(async () => {
    await cleanup(session);
    sandbox.dispose();
  });
  let submitted = 0;
  let sawNativeClearance = false;
  session = await startCodex({
    cwd: project.cwd,
    stateDir: project.stateDir,
    initialSize: { cols: 100, rows: 30 },
    autotrust: false,
    sandbox: "read-only",
    approvalPolicy: "never",
    hooks: {
      UserPromptSubmit: () => {
        submitted++;
      },
    },
  });
  const active = session;
  const clear = liveCodexClearance(() => active.terminal);
  active.on("terminal:data", () => {
    sawNativeClearance ||= clear(active.terminal.snapshot().text);
  });
  let sent = false;
  const pending = active
    .sendMessage(
      "Reply exactly ELWOOD_NATIVE_CURSOR_QUEUE_PROBE. Do not use tools or modify files.",
    )
    .then(() => {
      sent = true;
    });
  void pending.catch(() => undefined);
  await waitFor(
    () =>
      /Do you trust the contents of this directory\?/.test(active.terminal.snapshot().text) &&
      /Yes, continue/.test(active.terminal.snapshot().text)
        ? true
        : undefined,
    "native untrusted directory dialog",
    25_000,
  );
  await active.terminal.settled();
  assert.equal(settledCursorVisible(active.terminal.xterm), false);
  assert.equal(sent, false);
  assert.equal(submitted, 0);
  assert.equal(clear(active.terminal.snapshot().text), false);
  await active.sendKeys("1\r");
  await waitFor(
    () => (submitted === 1 ? true : undefined),
    "one queued production submission",
    45_000,
  );
  await pending;
  assert.equal(sawNativeClearance, true);
  assert.equal(submitted, 1);
  t.diagnostic(
    "Real startCodex, isolated config, human directory trust, native cursor, one benign queued submission.",
  );
});
