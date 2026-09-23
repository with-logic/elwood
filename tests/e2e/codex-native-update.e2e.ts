/** Real Codex 0.155.1 updater partial frames keep caller input held (C-CODEX-12). */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { nativeUpdaterSandbox } from "./codex-native-update-sandbox.ts";
import { observeSession, waitFor } from "./helpers.ts";

const binary = join(
  homedir(),
  ".codex/packages/standalone/releases/0.155.1-aarch64-apple-darwin/bin/codex",
);
const available = existsSync(binary) && existsSync(join(homedir(), ".codex/auth.json"));

test("C-CODEX-12 genuine narrow updater holds queued input without selecting a menu action", {
  skip: available ? false : "requires local standalone Codex 0.155.1 and Codex auth",
  timeout: 40_000,
}, async (t) => {
  const sandbox = await nativeUpdaterSandbox(binary);
  let session: CodexSessionApi | undefined;
  t.after(async () => {
    try {
      await session?.kill();
      await session?.teardown();
    } finally {
      resetRuntimeSeamsForTests();
      sandbox.dispose();
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
  for (const rows of [6, 3]) {
    if (rows !== 6) await active.resize({ cols: 100, rows });
    await waitFor(
      () => {
        const frame = active.terminal.snapshot();
        return frame.rows === rows &&
          frame.text.includes("0.155.1 -> 0.156.1") &&
          (rows === 3 || frame.text.includes("1. Update now"))
          ? true
          : undefined;
      },
      `native updater at 100x${rows}`,
      15_000,
    );
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
    "Real Codex 0.155.1 updater: 100x6 and 100x3 blocked, attention observed, zero attempted application writes; queued message rejected on shutdown.",
  );
});
