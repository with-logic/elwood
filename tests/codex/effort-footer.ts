/**
 * Shared setup for Codex sessions that wait for a requested effort's label: Codex 0.172's
 * captured `default` and `low` footers, and a start that paints the `default` footer at a
 * chosen time after launch on the fake clock (PRD §5.3, C-API-28).
 */
import { vi } from "vitest";
import { deadlineClock } from "../../src/core/timers.ts";
import {
  type ElwoodActivityEvent,
  type ElwoodWarningEvent,
  type ResumeCodexOptions,
  resumeCodex,
  type StartCodexOptions,
  startCodex,
} from "../../src/index.ts";
import { codexTty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { becomeReady, installFakes, ptys, tempDir } from "./helpers.ts";

export const effortDefault = capturedFrame("codex-0.172.0/boot/effort-default");
export const effortLow = capturedFrame("codex-0.172.0/boot/effort-low");
export const paint = (text: string) => `\u001b[2J\u001b[H${codexTty(text, true)}`;
export const paste = "\u001b[200~after configuration\u001b[201~";
export const initialSize = { cols: 140, rows: 45 } as const;
/** Screen text the content-free warning must never carry. */
export const sentinel = "elwood-effort-sentinel";

/**
 * Start, write "after configuration" (a queued message, or a prompt, which waits for the write
 * hold instead of readiness), paint the default footer `firstFrameAfterMs` after launch, and
 * wait `afterFrameMs` more. A host on defaults waits for `ready` from the start (`waited`).
 * Callers restore mocks and real timers, and tear the session down.
 */
/** When the default footer is painted, how long the start then runs, and what it wrote. */
export type DefaultFooterTiming = {
  readonly firstFrameAfterMs?: number;
  readonly afterFrameMs?: number;
  readonly write?: "message" | "prompt";
};

export async function deadlineOnDefaultFooter(
  options: Partial<StartCodexOptions>,
  { firstFrameAfterMs = 0, afterFrameMs = 10_500, write = "message" }: DefaultFooterTiming = {},
) {
  installFakes();
  // The effort wait counts from launch on the monotonic clock, which fake timers restart at 0.
  // Date continues across the switch, so launch and the first frame share one timeline.
  vi.spyOn(deadlineClock, "now").mockImplementation(() => Date.now());
  const session = await startCodex({ cwd: tempDir(), initialSize, ...options });
  const warnings: ElwoodWarningEvent[] = [];
  const activities: ElwoodActivityEvent[] = [];
  session.on("warning", (warning) => warnings.push(warning));
  session.on("activity", (event) => activities.push(event));
  const message = write === "message" ? session.sendMessage("after configuration") : undefined;
  // The startup warning gate opens on a real timer before this test takes over the clock.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.useFakeTimers();
  // A prompt's write polls the write hold on the clock, so it starts on the fake one.
  const queued = message ?? session.sendPrompt("after configuration");
  // Teardown rejects pending input if an assertion fails.
  void queued.catch(() => undefined);
  const waited = session
    .waitForStatus((status) => status === "ready")
    .then(
      (status) => status,
      (error: unknown) => error,
    );
  await vi.advanceTimersByTimeAsync(firstFrameAfterMs);
  ptys[0]!.emitData(paint(effortDefault.replace("elwood-boot-CAPTURE", sentinel)));
  await vi.advanceTimersByTimeAsync(afterFrameMs);
  return { session, warnings, activities, queued, waited, pty: ptys[0]! };
}

/**
 * Start a session, make it ready and stop it, then resume it with `options` and queue "after
 * configuration". `render` paints a frame on the resumed PTY and lets it settle; `ready`
 * settles once the resumed session reaches `ready`. Callers tear the session down.
 */
export async function resumeWithQueuedMessage(
  options: Pick<ResumeCodexOptions, "reasoningEffort" | "configOverrides">,
) {
  const cwd = tempDir();
  installFakes();
  const first = await startCodex({ cwd });
  await becomeReady(first.elwoodSessionId, cwd);
  await first.stop();
  const elwoodSessionId = first.elwoodSessionId;
  const resumed = await resumeCodex({ cwd, elwoodSessionId, initialSize, ...options });
  const warnings: ElwoodWarningEvent[] = [];
  resumed.on("warning", (warning) => warnings.push(warning));
  const queued = resumed.sendMessage("after configuration");
  void queued.catch(() => undefined);
  const ready = resumed.waitForStatus((status) => status === "ready");
  void ready.catch(() => undefined);
  const pty = ptys[1]!;
  const render = async (frame: string) => {
    pty.emitData(paint(frame));
    await resumed.terminal.settled();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { resumed, warnings, queued, ready, render, pty };
}
