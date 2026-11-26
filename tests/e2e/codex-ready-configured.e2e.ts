/**
 * Real Codex 0.172 behind a slow network paints its status footer seconds before it applies
 * the session's configuration, which discards a mode picked before it. Readiness waits for
 * the requested effort Codex applied (PRD §5.3, C-API-28, C-E2E-34).
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CodexSession } from "../../src/index.ts";
import { skipIf, skipReason } from "./availability.ts";
import { startDelayingProxy } from "./delaying-proxy.ts";
import {
  publicCodexQuestionSandbox,
  waitForPublicCodexQuestion,
} from "./questions/codex-public-sandbox.ts";
import {
  nativeQuestionSize,
  questionCodexBinary,
  questionCodexModel,
} from "./questions/codex-sandbox.ts";

// Every connection waits this long, so Codex loads its model catalog, and paints its footer,
// before its thread starts; the configuration then waits for further connections.
const connectionHoldMs = 12_000;
const pinnedCodex =
  existsSync(questionCodexBinary) && existsSync(join(homedir(), ".codex/auth.json"))
    ? undefined
    : "requires pinned Codex 0.172 and auth";

test("C-E2E-34 Codex reaches ready only once it shows the effort it applied, so Plan mode survives", {
  skip: skipIf(skipReason("codex"), pinnedCodex),
  timeout: 180_000,
}, async () => {
  const proxy = await startDelayingProxy(connectionHoldMs);
  let sandbox: Awaited<ReturnType<typeof publicCodexQuestionSandbox>> | undefined;
  let session: CodexSession | undefined;
  try {
    sandbox = await publicCodexQuestionSandbox();
    session = new CodexSession({
      cwd: sandbox.cwd,
      stateDir: sandbox.stateDir,
      model: questionCodexModel,
      reasoningEffort: "low",
      autotrust: true,
      autoupdate: false,
      sandbox: "read-only",
      approvalPolicy: "never",
      initialSize: nativeQuestionSize,
      env: proxy.env,
    });
    const live = await session.start();
    const screen = () => live.terminal.snapshot().text;
    await live.waitForStatus((status) => status === "ready", 120_000);
    const footer = screen()
      .split("\n")
      .find((row) => /^ {2}GPT-6-Luna /.test(row))
      ?.trim();
    assert.equal(footer, "GPT-6-Luna low", "ready waits for the effort Codex applied");
    assert.ok(proxy.tunnels() > 0, "Codex connected through the delaying proxy");
    await live.sendKeys("/plan");
    await waitForPublicCodexQuestion(() => /^›\s*\/plan\s*$/m.test(screen()));
    await live.sendKeys("\r");
    const planMode = () => screen().includes("Plan mode (");
    await waitForPublicCodexQuestion(planMode);
    // A configuration still in flight waits for at least one more held connection.
    await delay(connectionHoldMs + 1_000);
    assert.ok(planMode(), `Plan mode survives Codex's configuration:\n${screen()}`);
  } finally {
    try {
      await session?.close();
      sandbox?.dispose();
    } finally {
      await proxy.close();
    }
  }
});
