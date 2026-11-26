/**
 * Claude's first-launch screens are startup screens Elwood does not recognize: from the
 * readiness deadline they block the session, with their text, and raw keys answer them
 * (PRD §5.4, C-ATTN-09).
 */
import { afterEach, expect, test, vi } from "vitest";
import {
  type ClaudeSessionApi,
  type ElwoodActivityEvent,
  type ElwoodSessionStatus,
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

/** Claude 2.1.332's text-style picker on a first launch. */
const themePicker = capturedFrame("claude-2.1.332/startup/theme-picker").trimEnd();
const securityNotes = [
  " Security notes:",
  "",
  " 1. Claude can make mistakes.",
  "",
  " Press Enter to continue",
].join("\n");

test("C-ATTN-09 Claude's text-style picker blocks at the deadline and raw keys answer it", async () => {
  installFakes();
  const session = await startClaude({ cwd: tempDir() });
  sessions.push(session);
  const statuses: ElwoodSessionStatus[] = [];
  const activities: ElwoodActivityEvent[] = [];
  session.on("status", ({ status }) => statuses.push(status));
  session.on("activity", (event) => activities.push(event));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.useFakeTimers();
  const paint = async (frame: string) => {
    ptys[0]!.emitData(`\u001b[2J\u001b[H${frame}`);
    const settled = session.terminal.settled();
    await vi.advanceTimersByTimeAsync(0);
    await settled;
  };
  const sent = session.sendPrompt("held behind first launch");
  void sent.catch(() => {});
  await paint(tty(themePicker));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(statuses).toEqual(["blocked"]);
  const reports = () => activities.filter(({ kind }) => kind === "unrecognized_startup");
  expect(reports()).toEqual([
    expect.objectContaining({ label: "initial_ready_deadline", text: themePicker }),
  ]);
  await session.sendKeys("\r");
  // The next first-launch screen continues the same run of unrecognized screens.
  await paint(tty(securityNotes));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(reports()).toHaveLength(1);
  expect(statuses).toEqual(["blocked"]);
  expect(ptys[0]!.writes).toEqual(["\r"]);
  await paint(claudeTty(claudeComposer));
  await vi.advanceTimersByTimeAsync(1_000);
  await sent;
  expect(statuses.slice(0, 2)).toEqual(["blocked", "ready"]);
  expect(ptys[0]!.writes).toEqual(["\r", "\u001b[200~held behind first launch\u001b[201~", "\r"]);
});
