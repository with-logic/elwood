/**
 * A Codex startup screen Elwood does not recognize blocks the session from the readiness
 * deadline, with its screen text, until a verified composer (PRD §5.4, C-ATTN-09).
 */
import { afterEach, expect, test, vi } from "vitest";
import {
  type CodexSessionApi,
  type ElwoodActivityEvent,
  type ElwoodSessionStatus,
  startCodex,
} from "../../src/index.ts";
import { codexComposer, codexTty, tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const sessions: CodexSessionApi[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.splice(0).map((session) => session.teardown()));
  resetFakes();
});

/** Codex 0.171.0's sign-in screen, for a Codex home with no login. Its logo is animated. */
const signIn = capturedFrame("codex-0.171.0/startup/sign-in").trimEnd();
const signInRedrawn = signIn.replace("Welcome to Codex", "Welcome  to Codex");
const boot = capturedFrame("codex-0.164.0/boot/boot-composer").trimEnd();
const working = "• Working (3s • esc to interrupt)\n› ";

async function start() {
  installFakes();
  const session = await startCodex({ cwd: tempDir() });
  sessions.push(session);
  const statuses: ElwoodSessionStatus[] = [];
  const activities: ElwoodActivityEvent[] = [];
  session.on("status", ({ status }) => statuses.push(status));
  session.on("activity", (event) => activities.push(event));
  // The startup warning gate opens on a real timer before this test takes over the clock.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.useFakeTimers();
  const paint = async (frame: string) => {
    ptys[0]!.emitData(`\u001b[2J\u001b[H${frame}`);
    const settled = session.terminal.settled();
    await vi.advanceTimersByTimeAsync(0);
    await settled;
  };
  /** Attention labels and screen reports, in order. */
  const reports = () =>
    activities.flatMap((event) =>
      event.kind === "attention" || event.kind === "unrecognized_startup"
        ? [`${event.kind} ${event.label}`]
        : [],
    );
  return { session, statuses, activities, paint, reports };
}

test("C-ATTN-09 Codex's sign-in screen blocks at the readiness deadline until a verified composer", async () => {
  const { session, statuses, activities, paint, reports } = await start();
  const sent = session.sendMessage("held behind the sign-in screen");
  void sent.catch(() => {});
  await paint(tty(signIn));
  await vi.advanceTimersByTimeAsync(9_999);
  expect(statuses).toEqual([]);
  expect(reports()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(statuses).toEqual(["blocked"]);
  expect(reports()).toEqual([
    "attention codex-unrecognized-startup",
    "unrecognized_startup initial_ready_deadline",
  ]);
  expect(activities.find(({ kind }) => kind === "unrecognized_startup")).toEqual({
    elwoodSessionId: session.elwoodSessionId,
    agent: "codex",
    source: "terminal",
    kind: "unrecognized_startup",
    label: "initial_ready_deadline",
    text: signIn,
  });
  // Raw caller input answers the screen; nothing else is written to it.
  await session.sendKeys("3");
  expect(ptys[0]!.writes).toEqual(["3"]);
  await paint(codexTty(codexComposer));
  await vi.advanceTimersByTimeAsync(500);
  await sent;
  expect(statuses.slice(0, 2)).toEqual(["blocked", "ready"]);
  expect(ptys[0]!.writes).toEqual([
    "3",
    "\u001b[200~held behind the sign-in screen\u001b[201~",
    "\r",
  ]);
});

test("C-ATTN-09 an animated screen reports once, and a screen after a recognized frame again", async () => {
  const { statuses, paint, reports } = await start();
  await paint(tty(signIn));
  await vi.advanceTimersByTimeAsync(10_000);
  await paint(tty(signInRedrawn));
  expect(reports()).toEqual([
    "attention codex-unrecognized-startup",
    "unrecognized_startup initial_ready_deadline",
  ]);
  // Codex's boot composer is its own startup screen: it ends the run, not the block.
  await paint(codexTty(boot));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(statuses).toEqual(["blocked"]);
  await paint(tty(signIn));
  expect(reports()).toEqual([
    "attention codex-unrecognized-startup",
    "unrecognized_startup initial_ready_deadline",
    "unrecognized_startup initial_ready_deadline",
  ]);
  expect(statuses).toEqual(["blocked"]);
});

test("C-ATTN-09 a recognized dialog keeps the session blocked under its own label", async () => {
  const { statuses, paint, reports } = await start();
  await paint(tty(signIn));
  await vi.advanceTimersByTimeAsync(10_000);
  // An update offer without a safe choice blocks for the human (C-CODEX-12).
  await paint("Update available! 0.167.2 -> 0.169.0\r\n1. Update now");
  expect(statuses).toEqual(["blocked"]);
  expect(reports().at(-1)).toBe("attention codex-update-prompt");
  expect(ptys[0]!.writes).toEqual([]);
});

test("C-ATTN-09 work on screen clears the block to running", async () => {
  const { statuses, paint } = await start();
  await paint(tty(signIn));
  await vi.advanceTimersByTimeAsync(10_000);
  await paint(codexTty(working));
  expect(statuses).toEqual(["blocked", "running"]);
});

test("C-ATTN-09 after the first readiness no screen is an unrecognized startup screen", async () => {
  const { statuses, paint, reports } = await start();
  await paint(codexTty(codexComposer));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(statuses).toEqual(["ready"]);
  await paint(tty(signIn));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(statuses).toEqual(["ready"]);
  expect(reports()).toEqual([]);
});
