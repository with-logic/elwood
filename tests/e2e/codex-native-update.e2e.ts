/** Opt-in pinned native resize proof; empty/bannered frames hold caller input (C-CODEX-12). */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { nativeUpdaterSandbox } from "./codex-native-update-sandbox.ts";
import { cleanup, observeSession, skipIf, waitFor } from "./helpers.ts";

const binary = join(
  homedir(),
  ".codex/packages/standalone/releases/0.155.1-aarch64-apple-darwin/bin/codex",
);
const available = existsSync(binary) && existsSync(join(homedir(), ".codex/auth.json"));

test("C-CODEX-12 genuine narrow updater holds queued input without selecting a menu action", {
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
  t.diagnostic(
    JSON.stringify({
      version: sandbox.version,
      frames,
      attention: observed.activities
        .filter((event) => event.kind === "attention")
        .map((event) => event.label),
      applicationAttempts: sandbox.applicationAttempts.length,
    }),
  );
  t.diagnostic(
    "Real pinned Codex updater resized 100x6→2→1→3→6; recorded actual frames, blocked status and zero application attempts; no menu action or model prompt delivered.",
  );
});
