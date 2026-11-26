/**
 * A first frame Codex draws more than 40 s after launch ends the wait for a requested effort's
 * label with the deadline, not at 50 s, so a pre-ready prompt held by the write hold reaches
 * Codex together with readiness, never on a `default` footer before it (PRD §5.3, C-API-28).
 */
import { afterEach, expect, test, vi } from "vitest";
import { deadlineOnDefaultFooter, paste } from "./effort-footer.ts";
import { resetFakes } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

test("C-API-28 a late first frame holds a pre-ready prompt until the deadline", async () => {
  const { session, warnings, queued, pty } = await deadlineOnDefaultFooter(
    { reasoningEffort: "low" },
    { firstFrameAfterMs: 45_000, afterFrameMs: 5_500, write: "prompt" },
  );
  try {
    // 50.5 s after launch, 5.5 s after the frame: its deadline is still to come.
    expect(pty.writes).not.toContain(paste);
    expect(warnings).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    await queued;
    expect(pty.writes).toContain(paste);
    expect(warnings.map(({ code }) => code)).toEqual(["codex_effort_unconfirmed"]);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
