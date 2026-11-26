/**
 * A resumed Codex session that requests an effort follows the same wait for its label as a
 * start: a footer that stays `default` holds readiness and queued writes until 50 s after
 * launch, then releases both with one content-free `codex_effort_unconfirmed` warning
 * (PRD §5.3, C-API-28).
 */
import { afterEach, expect, test, vi } from "vitest";
import { deadlineClock } from "../../src/core/timers.ts";
import { type ElwoodWarningEvent, resumeCodex, startCodex } from "../../src/index.ts";
import { effortDefault, initialSize, paint, paste } from "./effort-footer.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

test("C-API-28 a resume whose footer stays default is ready when the wait for the label ends", async () => {
  const cwd = tempDir();
  installFakes();
  const first = await startCodex({ cwd });
  await becomeReady(first.elwoodSessionId, cwd);
  await first.stop();
  // Launch and the fake clock share Date's timeline; fake timers restart the monotonic one.
  vi.spyOn(deadlineClock, "now").mockImplementation(() => Date.now());
  const { elwoodSessionId } = first;
  const resumed = await resumeCodex({ cwd, elwoodSessionId, initialSize, reasoningEffort: "low" });
  const warnings: ElwoodWarningEvent[] = [];
  resumed.on("warning", (warning) => warnings.push(warning));
  const queued = resumed.sendMessage("after configuration");
  void queued.catch(() => undefined);
  // The startup warning gate opens on a real timer before this test takes over the clock.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.useFakeTimers();
  try {
    ptys[1]!.emitData(paint(effortDefault));
    // The resumed composer path, like the deadline, waits for the label.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(resumed.status).not.toBe("ready");
    expect(ptys[1]!.writes).not.toContain(paste);
    expect(warnings).toEqual([]);
    // With no repaint: the wait's end re-reads the current frame.
    await vi.advanceTimersByTimeAsync(6_000);
    await queued;
    expect(ptys[1]!.writes).toContain(paste);
    expect(warnings.map(({ code }) => code)).toEqual(["codex_effort_unconfirmed"]);
  } finally {
    vi.useRealTimers();
    await resumed.teardown();
  }
});
