/** Opt-in pinned native resize proof; narrow frames hold input; a full native menu permits only Skip (C-CODEX-12). */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { classifyCodexUpdateFrame } from "../../src/codex/update/classification.ts";
import { safeUpdateOption } from "../../src/codex/update/selection.ts";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { nativeUpdaterSandbox } from "./codex-native-update-sandbox.ts";
import { cleanup, observeSession, skipIf, waitFor } from "./helpers.ts";

const binary = join(
  homedir(),
  ".codex/packages/standalone/releases/0.155.1-aarch64-apple-darwin/bin/codex",
);
const available = existsSync(binary) && existsSync(join(homedir(), ".codex/auth.json"));

test("C-CODEX-12 genuine updater holds narrow input and selects only the full-menu safe digit", {
  skip: skipIf(
    process.env["ELWOOD_NATIVE_UPDATE_PROOF"] === "1"
      ? available
        ? undefined
        : "requires local standalone Codex 0.155.1 and Codex auth"
      : "set ELWOOD_NATIVE_UPDATE_PROOF=1 for isolated native updater proof",
  ),
  timeout: 60_000,
}, async (t) => {
  const parentCodexHome = process.env["CODEX_HOME"];
  const sandbox = await nativeUpdaterSandbox(binary);
  assert.equal(process.env["CODEX_HOME"], parentCodexHome);
  let session: CodexSessionApi | undefined;
  t.after(async () => {
    try {
      await cleanup(session);
    } finally {
      resetRuntimeSeamsForTests();
      sandbox.dispose();
      assert.equal(process.env["CODEX_HOME"], parentCodexHome);
    }
  });
  session = await startCodex({
    cwd: sandbox.project,
    stateDir: join(sandbox.project, ".state"),
    initialSize: { cols: 100, rows: 6 },
    autoupdate: false,
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  const active = session;
  const observed = observeSession(active);
  t.after(() => observed.dispose());
  let settled = false;
  const queued = active.sendMessage("ELWOOD_HELD_NATIVE_UPDATER").then(
    () => {
      settled = true;
      return "fulfilled";
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  const frames: { rows: number; text: string; status: string }[] = [];
  for (const rows of [6, 2, 1, 3, 6]) {
    const priorEvents = observed.terminal.length;
    if (rows !== 6 || frames.length > 0) await active.resize({ cols: 100, rows });
    await waitFor(
      () => {
        const frame = active.terminal.snapshot();
        return frame.rows === rows &&
          (frames.length === 0
            ? frame.text.includes("0.155.1 -> 0.156.1")
            : observed.terminal.length > priorEvents)
          ? true
          : undefined;
      },
      `native resize repaint at 100x${rows}`,
      10_000,
    );
    await delay(250);
    await waitFor(
      () =>
        active.status === "blocked" &&
        observed.activities.some(
          (event) => event.kind === "attention" && event.label === "codex-update-prompt",
        )
          ? true
          : undefined,
      "blocked updater attention",
      10_000,
    );
    await active.terminal.settled();
    const frame = active.terminal.snapshot();
    if (rows === 1) {
      assert.equal(frame.text.trim(), "");
      assert.ok(
        observed.activities.some(
          (event) => event.kind === "attention" && event.label === "codex-unidentified-dialog",
        ),
      );
    } else assert.ok(frame.text.includes("0.155.1 -> 0.156.1"));
    assert.equal(frame.text.includes("2. Skip"), false);
    assert.equal(settled, false);
    assert.deepEqual(sandbox.applicationAttempts, []);
    frames.push({ rows, text: frame.text, status: active.status });
  }
  await active.kill();
  assert.notEqual(await queued, "fulfilled");
  assert.deepEqual(sandbox.applicationAttempts, []);
  // The held caller belongs to the closed session. The positive phase has no prompt.
  session = await startCodex({
    cwd: sandbox.project,
    stateDir: join(sandbox.project, ".positive-state"),
    initialSize: { cols: 100, rows: 6 },
    autoupdate: false,
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  const positive = session;
  await waitFor(
    () => (positive.terminal.snapshot().text.includes("0.155.1 -> 0.156.1") ? true : undefined),
    "second native updater banner",
    10_000,
  );
  const safeFrames: string[] = [];
  sandbox.permitSafeSelection((input) => {
    const text = positive.terminal.snapshot().text;
    const frame = classifyCodexUpdateFrame(text);
    const choice = safeUpdateOption(text, frame.options ?? []);
    if (input !== "2" || !frame.hasBanner || choice?.number !== "2" || choice.label !== "Skip")
      return false;
    safeFrames.push(text);
    return true;
  });
  await positive.resize({ cols: 100, rows: 30 });
  await waitFor(
    () => (positive.status === "ready" ? true : undefined),
    "native ready after Skip",
    15_000,
  );
  assert.deepEqual(sandbox.applicationAttempts, ["2"]);
  assert.equal(safeFrames.length, 1);
  await positive.kill();
  t.diagnostic(
    JSON.stringify({
      version: sandbox.version,
      frames,
      attention: observed.activities
        .filter((event) => event.kind === "attention")
        .map((event) => event.label),
      applicationAttempts: sandbox.applicationAttempts,
      safeFrames,
    }),
  );
  t.diagnostic(
    "Real pinned Codex updater narrow sequence held caller input with zero attempts. A second prompt-free session resized100x6→30, sent only current native2.Skip and reached ready; no update or model prompt delivered.",
  );
});
