/**
 * A requested effort holds Codex readiness and queued writes until its footer shows a label
 * other than `default`, or until the backstop falls, which releases them with a content-free
 * `codex_effort_unconfirmed` warning (PRD §5.3, §5.7, C-API-28).
 */
import { afterEach, expect, test, vi } from "vitest";
import {
  type ElwoodActivityEvent,
  type ElwoodWarningEvent,
  resumeCodex,
  type StartCodexOptions,
  startCodex,
} from "../../src/index.ts";
import { codexTty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const effortDefault = capturedFrame("codex-0.172.0/boot/effort-default");
const effortLow = capturedFrame("codex-0.172.0/boot/effort-low");
const paint = (text: string) => `\u001b[2J\u001b[H${codexTty(text, true)}`;
const paste = "\u001b[200~after configuration\u001b[201~";
const initialSize = { cols: 140, rows: 45 };
/** Screen text the content-free warning must never carry. */
const sentinel = "elwood-effort-sentinel";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

/** Start, queue a message, and paint the default footer `firstFrameAfterMs` after launch. */
async function deadlineOnDefaultFooter(options: Partial<StartCodexOptions>, firstFrameAfterMs = 0) {
  installFakes();
  const session = await startCodex({ cwd: tempDir(), initialSize, ...options });
  const warnings: ElwoodWarningEvent[] = [];
  const activities: ElwoodActivityEvent[] = [];
  session.on("warning", (warning) => warnings.push(warning));
  session.on("activity", (event) => activities.push(event));
  const queued = session.sendMessage("after configuration");
  // Teardown rejects pending input if an assertion fails.
  void queued.catch(() => undefined);
  // The startup warning gate opens on a real timer before this test takes over the clock.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(firstFrameAfterMs);
  ptys[0]!.emitData(paint(effortDefault.replace("elwood-boot-CAPTURE", sentinel)));
  await vi.advanceTimersByTimeAsync(10_500);
  return { session, warnings, activities, queued, pty: ptys[0]! };
}

test("C-API-28 a requested effort holds ready until Codex shows it", async () => {
  const { session, warnings, activities, queued, pty } = await deadlineOnDefaultFooter({
    reasoningEffort: "low",
  });
  try {
    // Past the deadline, the footer waiting for the effort is Codex's own startup screen.
    expect(session.status).not.toBe("blocked");
    expect(activities.some(({ kind }) => kind === "unrecognized_startup")).toBe(false);
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

test.each([
  { label: "no effort", options: {} },
  {
    label: "an effort only in configOverrides",
    options: { configOverrides: ["model_reasoning_effort=low"] },
  },
])("C-API-28 with $label the deadline marks ready on the default footer", async ({ options }) => {
  const { session, warnings, queued, pty } = await deadlineOnDefaultFooter(options);
  try {
    await queued;
    expect(pty.writes).toContain(paste);
    expect(warnings).toEqual([]);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});

test("C-API-28 the effort wait lapses at the backstop after a late first frame, with a warning", async () => {
  // Launch time before the first frame does not count toward the lapse.
  const { session, warnings, activities, queued, pty } = await deadlineOnDefaultFooter(
    { reasoningEffort: "low" },
    55_000,
  );
  try {
    await vi.advanceTimersByTimeAsync(49_000);
    expect(session.status).not.toBe("ready");
    expect(pty.writes).not.toContain(paste);
    expect(warnings).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    await queued;
    expect(pty.writes).toContain(paste);
    const warning = {
      elwoodSessionId: session.elwoodSessionId,
      agent: "codex",
      source: "lifecycle",
      code: "codex_effort_unconfirmed",
      severity: "warning",
      message:
        "Codex did not show the requested reasoning effort within 60 seconds; readiness was released on its status footer, and a mode or model picked before Codex applies its configuration can be discarded.",
      raw: "codex_effort_unconfirmed",
    } as const;
    expect(warnings).toEqual([warning]);
    const projected = activities.filter(({ kind }) => kind === "warning");
    expect(projected).toEqual([
      {
        elwoodSessionId: session.elwoodSessionId,
        agent: "codex",
        source: "lifecycle",
        kind: "warning",
        label: warning.code,
        text: warning.message,
        raw: warning,
      },
    ]);
    expect(activities.some(({ kind }) => kind === "unrecognized_startup")).toBe(false);
    expect(session.terminal.snapshot().text).toContain(sentinel);
    expect(JSON.stringify([warnings, projected])).not.toContain(sentinel);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});

test("C-API-28 a resume that requests an effort waits for Codex to show it", async () => {
  const cwd = tempDir();
  installFakes();
  const first = await startCodex({ cwd });
  await becomeReady(first.elwoodSessionId, cwd);
  await first.stop();
  const elwoodSessionId = first.elwoodSessionId;
  const resumed = await resumeCodex({ cwd, elwoodSessionId, initialSize, reasoningEffort: "low" });
  const queued = resumed.sendMessage("after configuration");
  void queued.catch(() => undefined);
  const render = async (frame: string) => {
    ptys[1]!.emitData(paint(frame));
    await resumed.terminal.settled();
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    await render(effortDefault);
    expect(resumed.status).not.toBe("ready");
    expect(ptys[1]!.writes).not.toContain(paste);
    await render(effortLow);
    await queued;
    expect(ptys[1]!.writes).toContain(paste);
  } finally {
    await resumed.teardown();
  }
});
