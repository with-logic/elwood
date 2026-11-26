/** A requested effort holds Codex readiness and queued writes until its footer shows it (C-API-28). */
import { afterEach, expect, test, vi } from "vitest";
import { type ElwoodWarningEvent, type StartCodexOptions, startCodex } from "../../src/index.ts";
import { codexTty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const effortDefault = capturedFrame("codex-0.172.0/boot/effort-default");
const effortLow = capturedFrame("codex-0.172.0/boot/effort-low");
const paint = (text: string) => `\u001b[2J\u001b[H${codexTty(text, true)}`;
const paste = "\u001b[200~after configuration\u001b[201~";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

async function deadlineOnDefaultFooter(options: Partial<StartCodexOptions>) {
  installFakes();
  const session = await startCodex({
    cwd: tempDir(),
    initialSize: { cols: 140, rows: 45 },
    ...options,
  });
  const warnings: ElwoodWarningEvent[] = [];
  session.on("warning", (warning) => warnings.push(warning));
  const queued = session.sendMessage("after configuration");
  // Teardown rejects pending input if an assertion fails.
  void queued.catch(() => undefined);
  // The startup warning gate opens on a real timer before this test takes over the clock.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.useFakeTimers();
  ptys[0]!.emitData(paint(effortDefault));
  await vi.advanceTimersByTimeAsync(10_500);
  return { session, warnings, queued, pty: ptys[0]! };
}

test("C-API-28 a requested effort holds ready until Codex shows it", async () => {
  const { session, warnings, queued, pty } = await deadlineOnDefaultFooter({
    reasoningEffort: "low",
  });
  try {
    expect(session.status).not.toBe("ready");
    expect(pty.writes).not.toContain(paste);
    pty.emitData(paint(effortLow));
    await vi.advanceTimersByTimeAsync(500);
    await queued;
    expect(pty.writes).toContain(paste);
    expect(warnings).toEqual([]);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});

test("C-API-28 without a requested effort the deadline marks ready on the default footer", async () => {
  const { session, queued, pty } = await deadlineOnDefaultFooter({});
  try {
    await queued;
    expect(pty.writes).toContain(paste);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});

test("C-API-28 a footer that never shows the requested effort marks ready by the backstop", async () => {
  const { session, warnings, queued, pty } = await deadlineOnDefaultFooter({
    reasoningEffort: "low",
  });
  try {
    await vi.advanceTimersByTimeAsync(48_000);
    expect(pty.writes).not.toContain(paste);
    await vi.advanceTimersByTimeAsync(2_000);
    await queued;
    expect(pty.writes).toContain(paste);
    expect(warnings.map((warning) => warning.code)).toEqual(["codex_effort_unconfirmed"]);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
