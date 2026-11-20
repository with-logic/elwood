/** A session reaches `ready` on Codex's wrapped footer at its terminal's width (C-CODEX-26). */
import { afterEach, expect, test, vi } from "vitest";
import {
  type CodexSessionApi,
  type ElwoodSessionStatus,
  type ElwoodWarningEvent,
  startCodex,
} from "../../src/index.ts";
import {
  type CapturedFooter,
  codexFooterCaptures170,
} from "../fixtures/codex-footer-captures-170.ts";
import { codexTty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { type FakePty, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const sessions: CodexSessionApi[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.splice(0).map((session) => session.teardown()));
  resetFakes();
});

const boot = capturedFrame("codex-0.164.0/boot/boot-composer").trimEnd();
const wrapped = codexFooterCaptures170.filter((capture) => capture.wrapped);

/** Start a session `cols` wide, queue a prompt, and paint the capture after the boot composer. */
async function startAt(cols: number, capture: CapturedFooter, resizeTo?: number) {
  installFakes();
  const session = await startCodex({ cwd: tempDir(), initialSize: { cols, rows: 12 } });
  sessions.push(session);
  const pty: FakePty | undefined = ptys[0];
  if (pty === undefined) throw new Error("The session started no PTY.");
  const warnings: ElwoodWarningEvent[] = [];
  const statuses: ElwoodSessionStatus[] = [];
  session.on("warning", (warning) => warnings.push(warning));
  session.on("status", ({ status }) => statuses.push(status));
  // The startup warning gate opens on a real timer before this test takes over the clock.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.useFakeTimers();
  const settle = async (ms: number) => {
    const settled = session.terminal.settled();
    await vi.advanceTimersByTimeAsync(0);
    await settled;
    await vi.advanceTimersByTimeAsync(ms);
  };
  const sent = session.sendMessage("queued prompt");
  void sent.catch(() => {});
  pty.emitData(codexTty(boot));
  await settle(5_000);
  pty.emitData(`\u001b[2J\u001b[H${codexTty(capture.rows.join("\n"))}`);
  if (resizeTo !== undefined) {
    await settle(0);
    await session.resize({ cols: resizeTo, rows: 12 });
  }
  await settle(5_500);
  return { pty, warnings, statuses, sent };
}

test.each(
  wrapped,
)("C-CODEX-26 a $cols-column session types its queued prompt: $shape", async (capture) => {
  const { pty, warnings, statuses, sent } = await startAt(capture.cols, capture);
  expect(statuses).toEqual(["ready", "running"]);
  await sent;
  expect(pty.writes).toEqual(["\u001b[200~queued prompt\u001b[201~", "\r"]);
  expect(warnings).toEqual([]);
});

test.each(
  wrapped,
)("C-CODEX-26 rows a wider terminal did not cut hold the prompt: $cols columns, $shape", async (capture) => {
  const { pty, warnings, statuses } = await startAt(capture.cols * 4, capture);
  expect(statuses).toEqual([]);
  expect(pty.writes).toEqual([]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(statuses).toEqual([]);
  expect(pty.writes).toEqual([]);
  expect(warnings.map((warning) => warning.code)).toEqual(["initial_ready_backstop"]);
});

test("C-CODEX-26 a resize before the deadline preserves the captured footer width", async () => {
  const capture = wrapped[0]!;
  const { pty, statuses, sent } = await startAt(capture.cols, capture, capture.cols * 2);
  expect(statuses).toEqual(["ready", "running"]);
  await sent;
  expect(pty.writes).toEqual(["\u001b[200~queued prompt\u001b[201~", "\r"]);
});
