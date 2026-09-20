/** A blocking prompt first seen while `starting` still announces itself (C-ATTN-03, C-CLI-05). */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { executeRun } from "../../src/cli/run/index.ts";
import { HeadlessCliSession } from "../../src/cli/session/index.ts";
import { createCliLaunch, defaultCliLaunchDependencies } from "../../src/cli/session/launch.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import { codexUpdateAttentionGraceMs } from "../../src/cli/update-attention.ts";
import type { ElwoodAgentSession } from "../../src/core/agent-session.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { claudeTrust, codexTrust, tty } from "../fixtures/trust-composer.ts";
import { paintWhileStarting } from "../helpers/startup-frame.ts";
import { effectiveRequest } from "./main-fakes.ts";
import { FakeClock, FakeSignals, MemoryWriter } from "./run-fakes.ts";

/** Complete native folder/directory trust gates: human-owned while `autotrust` is off. */
const gates = {
  claude: `${claudeTrust}\n❯ 1. Yes, I trust this folder\n  2. No, exit`,
  codex: `${codexTrust}\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue`,
};

afterEach(() => {
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});

test.each([
  "claude",
  "codex",
] as const)("C-ATTN-03 a %s trust gate painted while starting blocks with exactly one attention", async (agent) => {
  paintWhileStarting(gates[agent]);
  const helpers = agent === "claude" ? claude : codex;
  helpers.installFakes();
  const options = { cwd: helpers.tempDir(), autotrust: false };
  const session: ElwoodAgentSession =
    agent === "claude" ? await startClaude(options) : await startCodex(options);
  const attention: string[] = [];
  session.on("activity", (event) => {
    if (event.kind === "attention") attention.push(event.label);
  });
  try {
    await vi.waitFor(() => expect(session.status).toBe("blocked"));
    // The gate really was first seen before the session was live.
    expect(session.statusDecisions()[0]).toMatchObject({ from: "starting", to: undefined });
    helpers.ptys[0]!.emitData(tty(gates[agent])); // a repaint of the same gate stays quiet
    await session.terminal.settled();
    expect(attention).toEqual([`${agent}-workspace_trust-prompt`]);
    expect(helpers.ptys[0]!.writes).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test("C-CLI-05 a headless run facing a gate painted while starting reports blocked_prompt", async () => {
  paintWhileStarting(gates.codex);
  codex.installFakes();
  const cwd = codex.tempDir();
  const stateDir = join(cwd, ".elwood");
  const request = effectiveRequest({ cwd, stateDir, trust: false, timeoutMs: 60_000 });
  const id = randomUUID();
  const launch = createCliLaunch(request, id, defaultCliLaunchDependencies);
  const stderr = new MemoryWriter();
  const clock = new FakeClock();
  const running = executeRun(
    request,
    new HeadlessCliSession(request, id, launch),
    { stdout: new AsyncOutputSink(new MemoryWriter()), stderr: new AsyncOutputSink(stderr) },
    { signals: new FakeSignals(), clock },
  );
  // Without the attention activity nothing ends the run but its timeout (exit 124).
  const hung = setTimeout(() => {
    clock.value = 60_000;
    clock.fire();
  }, 3_000);
  await expect(running).resolves.toBe(1);
  clearTimeout(hung);
  expect(stderr.value).toContain("Blocked prompt: codex-workspace_trust-prompt.");
});

test("C-CODEX-12 a quietly exhausted update skip first seen while starting still ends as blocked_prompt", async () => {
  const update = "Update available! 0.153.3 -> 0.153.4\n  1. Update now\n  2. Skip";
  paintWhileStarting(update);
  codex.installFakes();
  const cwd = codex.tempDir();
  const request = effectiveRequest({ cwd, stateDir: join(cwd, ".elwood") });
  const id = randomUUID();
  const launch = createCliLaunch(request, id, defaultCliLaunchDependencies);
  const stderr = new MemoryWriter();
  const clock = new FakeClock();
  const running = executeRun(
    request,
    new HeadlessCliSession(request, id, launch),
    { stdout: new AsyncOutputSink(new MemoryWriter()), stderr: new AsyncOutputSink(stderr) },
    { signals: new FakeSignals(), clock },
  );
  // The one bounded attempt exhausts after five REAL seconds without a warning, so only
  // the startup `attention` (#37) can have armed the CLI's grace timer.
  await new Promise((resolve) => setTimeout(resolve, 5_600));
  expect(clock.delays).toEqual([codexUpdateAttentionGraceMs]);
  const keys = codex.ptys[0]?.writes.length;
  expect(keys).toBeGreaterThan(1);
  codex.ptys[0]?.emitData(tty(update)); // a repaint of the same screen starts no new loop
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(codex.ptys[0]?.writes).toHaveLength(keys ?? 0);
  clock.fire();
  await expect(running).resolves.toBe(1);
  expect(stderr.value).toContain("Blocked prompt: codex-update-prompt.");
}, 15_000);
