/**
 * Real Codex 0.172 that never applies its configuration keeps its footer's effort `default`.
 * A host that waits for `ready` with `waitForStatus`'s default timeout as soon as `start()`
 * resolves still sees `ready`, with `codex_effort_unconfirmed`, by 50 s after launch
 * (PRD §5.3, C-API-28, C-E2E-37).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CodexSession, type ElwoodWarningEvent } from "../../src/index.ts";
import type { PtyProcess } from "../../src/pty/types.ts";
import { skipIf, skipReason } from "./availability.ts";
import { startDelayingProxy } from "./delaying-proxy.ts";
import {
  publicCodexQuestionSandbox,
  publicCodexSessionOptions,
} from "./questions/codex-public-sandbox.ts";
import {
  codexFooterRow as footer,
  pinnedCodexSkip,
  questionCodexModel,
} from "./questions/codex-sandbox.ts";
import { runPublicProof } from "./questions/proof-run.ts";

// Held connections widen the seconds between Codex's `default` footer and its configuration,
// so the test stops Codex inside them.
const connectionHoldMs = 12_000;
// Codex paints its `default` footer seconds after launch; this run fails fast on one not drawn
// by 40 s. That keeps it in the launch-bound case, where the deadline, 10 s after the first
// frame, has passed when the wait ends 50 s after launch. It is not a limit on the default
// wait, which a first frame up to about 50 s after launch still meets.
const defaultFooterWithinMs = 40_000;
/** When the wait for the label ends, in the launch-bound case (C-API-28). */
const effortWaitFromLaunchMs = 50_000;
// `launched` is read just before `start()` makes the session, and `ready` needs a render after
// the wait ends; this covers both on a loaded machine. Main's lapse came about 61 s after it.
const launchSlackMs = 3_000;
// The host's wait starts after launch, so `ready` 50 s after launch comes sooner than that on
// its clock; main's lapse, 60 s after the first frame, came about 60 s into it.
const readyWithinMs = 55_000;
const pinnedSkip = pinnedCodexSkip();
const unconfigured = `${questionCodexModel} default`;

test("C-E2E-37 a host's default wait sees ready when Codex never applies its configuration", {
  skip: skipIf(skipReason("codex"), pinnedSkip),
  timeout: 150_000,
}, async (t) => {
  const proxy = await startDelayingProxy(connectionHoldMs);
  let sandbox: Awaited<ReturnType<typeof publicCodexQuestionSandbox>> | undefined;
  let session: CodexSession | undefined;
  // The Codex this test stopped, resumed on every path: right after the wait, at cleanup, and
  // if the process exits first. A runner killed by a signal closes the PTY instead, which
  // ends the stopped Codex too (docs/cli-behavior.md).
  let stoppedCodex: PtyProcess | undefined;
  const resume = () => {
    const codex = stoppedCodex;
    stoppedCodex = undefined;
    codex?.kill("SIGCONT");
  };
  process.once("exit", resume);
  const cleanups = [
    resume,
    () => process.off("exit", resume),
    () => session?.close(),
    () => sandbox?.dispose(),
    () => proxy.close(),
  ];
  await runPublicProof(t, cleanups, async () => {
    sandbox = await publicCodexQuestionSandbox();
    session = new CodexSession({
      ...publicCodexSessionOptions(sandbox),
      reasoningEffort: "low",
      env: proxy.env,
    });
    // Elapsed times use the monotonic clock, which a wall-clock adjustment cannot move.
    const launched = performance.now();
    const live = await session.start();
    const warnings: ElwoodWarningEvent[] = [];
    live.on("warning", (warning) => warnings.push(warning));
    const screen = () => live.terminal.snapshot().text;
    // A host on defaults: no timeout of its own, waiting as soon as the session exists.
    const waitStarted = performance.now();
    const settle = (status: string, shown: string | undefined) => ({
      status,
      shown,
      at: Math.round(performance.now() - waitStarted),
      sinceLaunch: Math.round(performance.now() - launched),
    });
    const waited = live
      .waitForStatus((status) => status === "ready")
      .then(
        (status) => settle(status, footer(screen())),
        (error: unknown) => settle(String(error), undefined),
      );
    while (!footer(screen())?.startsWith(unconfigured)) {
      assert.ok(
        performance.now() - launched < defaultFooterWithinMs,
        `Codex painted ${unconfigured}`,
      );
      await delay(20);
    }
    // Stopped inside the held connections, Codex never applies its configuration.
    const codex = sandbox.spawned();
    assert.ok(codex, "the sandbox spawned Codex on a PTY");
    t.diagnostic(`stopped the spawned Codex, pid ${codex.pid}`);
    stoppedCodex = codex;
    codex.kill("SIGSTOP");
    // The wait settles by its own default timeout, so Codex is stopped at most that long.
    const { status, at, shown, sinceLaunch } = await waited;
    resume();
    t.diagnostic(`ready ${at} ms into the host's wait, ${sinceLaunch} ms after launch`);
    assert.equal(status, "ready", `the default wait saw ready (${at} ms into it)`);
    assert.ok(
      sinceLaunch < effortWaitFromLaunchMs + launchSlackMs,
      `ready 50 s after launch, within ${launchSlackMs} ms: ${sinceLaunch} ms`,
    );
    assert.ok(at < readyWithinMs, `ready within ${readyWithinMs} ms of the host's wait: ${at} ms`);
    assert.ok(shown?.startsWith(unconfigured), `Codex had not applied its configuration: ${shown}`);
    const unconfirmed = warnings.filter(({ code }) => code === "codex_effort_unconfirmed");
    assert.equal(
      unconfirmed.length,
      1,
      `one codex_effort_unconfirmed: ${JSON.stringify(warnings)}`,
    );
  });
});
