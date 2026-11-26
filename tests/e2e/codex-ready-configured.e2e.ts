/**
 * Real Codex 0.172 behind a slow network paints its status footer seconds before it applies
 * the session's configuration, which discards a mode picked before it. Readiness waits for the
 * requested effort's label (PRD §5.3, C-API-28, C-E2E-34).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CodexSession } from "../../src/index.ts";
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

// Every connection waits this long, so Codex loads its model catalog, and paints its footer,
// before its thread starts; the configuration then waits for further connections. It must
// outlast Elwood's 10-second readiness deadline, so that the deadline has passed when the
// footer appears.
const connectionHoldMs = 12_000;
const effort = "low";
const pinnedSkip = pinnedCodexSkip();

async function waitForScreen(screen: () => string, check: (text: string) => boolean, what: string) {
  const deadline = Date.now() + 30_000;
  while (!check(screen())) {
    if (Date.now() > deadline)
      throw new Error(`C-E2E-34 timed out waiting for ${what}:\n${screen()}`);
    await delay(25);
  }
}

test("C-E2E-34 Codex reaches ready only once it shows the effort it applied, so Plan mode survives", {
  skip: skipIf(skipReason("codex"), pinnedSkip),
  timeout: 180_000,
}, async (t) => {
  const proxy = await startDelayingProxy(connectionHoldMs);
  let sandbox: Awaited<ReturnType<typeof publicCodexQuestionSandbox>> | undefined;
  let session: CodexSession | undefined;
  let polling: ReturnType<typeof setInterval> | undefined;
  const cleanups = [
    () => clearInterval(polling),
    () => session?.close(),
    () => sandbox?.dispose(),
    () => proxy.close(),
  ];
  await runPublicProof(t, cleanups, async () => {
    sandbox = await publicCodexQuestionSandbox();
    session = new CodexSession({
      ...publicCodexSessionOptions(sandbox),
      reasoningEffort: effort,
      env: proxy.env,
    });
    const live = await session.start();
    const screen = () => live.terminal.snapshot().text;
    let defaultBeforeReady = false;
    polling = setInterval(() => {
      const unconfigured = footer(screen())?.startsWith(`${questionCodexModel} default`);
      if (live.status !== "ready" && unconfigured) defaultBeforeReady = true;
    }, 20);
    await live.waitForStatus((status) => status === "ready", 120_000);
    clearInterval(polling);
    const failures = proxy.failures().join("; ") || "none";
    const network = `${proxy.openedTunnelCount()} tunnels opened, failures: ${failures}`;
    const applied = footer(screen());
    assert.ok(
      applied?.startsWith(`${questionCodexModel} ${effort}`),
      `ready waits for the effort Codex applied, footer ${applied} (${network})`,
    );
    // The race this proves: Codex showed its default footer while Elwood held readiness.
    assert.ok(defaultBeforeReady, `Codex showed its default footer before ready (${network})`);
    await live.sendKeys("/plan");
    await waitForScreen(screen, (text) => /^›\s*\/plan\s*$/m.test(text), "the /plan command");
    await live.sendKeys("\r");
    const planMode = (text: string) => text.includes("Plan mode (");
    await waitForScreen(screen, planMode, "Plan mode");
    // Without the fix, Codex applies its configuration about 6 s after its footer behind this
    // proxy; 13 s outlasts any configuration still in flight.
    await delay(connectionHoldMs + 1_000);
    assert.ok(planMode(screen()), `Plan mode survives Codex's configuration:\n${screen()}`);
    // Checked last: the held tunnels open only after a ready that comes too early.
    assert.ok(
      proxy.openedTunnelCount() > 0,
      `Codex connected through the delaying proxy (${proxy.openedTunnelCount()} tunnels opened)`,
    );
  });
});
