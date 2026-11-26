/**
 * A resumed Claude session that opens on a screen Elwood does not recognize blocks from the
 * readiness deadline and releases queued input on a verified composer (PRD §5.4, C-ATTN-11).
 */
import { afterEach, expect, test, vi } from "vitest";
import {
  type ClaudeSessionApi,
  type ElwoodActivityEvent,
  resumeClaude,
  startClaude,
} from "../../src/index.ts";
import { claudeComposer, claudeTty, tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const sessions: ClaudeSessionApi[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.splice(0).map((session) => session.teardown()));
  resetFakes();
});

const textStylePicker = capturedFrame("claude-2.1.332/startup/theme-picker").trimEnd();

async function paint(session: ClaudeSessionApi, frame: string): Promise<void> {
  ptys[1]!.emitData(`\u001b[2J\u001b[H${frame}`);
  const settled = session.terminal.settled();
  await vi.advanceTimersByTimeAsync(0);
  await settled;
}

test("C-ATTN-11 a resumed Claude session blocks on an unrecognized screen until a verified composer", async () => {
  installFakes();
  const cwd = tempDir();
  const original = await startClaude({ cwd });
  await ptys[0]!.dispatchHook(original.elwoodSessionId, {
    hook_event_name: "UserPromptSubmit",
    session_id: "claude-resume",
    cwd,
    prompt: "existing conversation",
    model: "fixture",
  });
  await original.stop();
  const session = await resumeClaude({ cwd, elwoodSessionId: original.elwoodSessionId });
  sessions.push(session);
  const activities: ElwoodActivityEvent[] = [];
  session.on("activity", (event) => activities.push(event));
  // The startup warning gate opens on a real timer before this test takes over the clock.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.useFakeTimers();
  const sent = session.sendMessage("held behind the screen");
  void sent.catch(() => {});
  await paint(session, tty(textStylePicker));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(session.status).toBe("blocked");
  expect(
    activities.flatMap((event) =>
      event.kind === "attention" || event.kind === "unrecognized_startup"
        ? [`${event.kind} ${event.label}`]
        : [],
    ),
  ).toEqual([
    "attention claude-unrecognized-startup",
    "unrecognized_startup initial_ready_deadline",
  ]);
  expect(ptys[1]!.writes).toEqual([]);
  await paint(session, claudeTty(claudeComposer));
  await vi.advanceTimersByTimeAsync(500);
  expect(session.status).not.toBe("blocked");
  expect(ptys[1]!.writes.join("")).toContain("held behind the screen");
  await sent;
});
