/**
 * A Codex startup screen Elwood does not recognize blocks the session from the readiness
 * deadline, with its screen text, until a verified composer (PRD §5.4, C-ATTN-11).
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
const bootComposer = capturedFrame("codex-0.164.0/boot/boot-composer").trimEnd();
/** Codex 0.172.0's header over its logo, drawn before its boot composer. */
const bootHeaderFrame = capturedFrame("codex-0.172.0/update/start-boot-partial").trimEnd();
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

test("C-ATTN-11 Codex's sign-in screen blocks at the readiness deadline until a verified composer", async () => {
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

test("C-ATTN-11 an animated screen reports once, and a screen after a recognized frame again", async () => {
  const { statuses, paint, reports } = await start();
  await paint(tty(signIn));
  await vi.advanceTimersByTimeAsync(10_000);
  await paint(tty(signInRedrawn));
  expect(reports()).toEqual([
    "attention codex-unrecognized-startup",
    "unrecognized_startup initial_ready_deadline",
  ]);
  // Codex's boot composer is its own startup screen: it ends the run, not the block.
  await paint(codexTty(bootComposer));
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

test("C-ATTN-11 a recognized dialog keeps the session blocked under its own label", async () => {
  const { statuses, paint, reports } = await start();
  await paint(tty(signIn));
  await vi.advanceTimersByTimeAsync(10_000);
  // An update offer without a safe choice blocks for the human (C-CODEX-12).
  await paint("Update available! 0.167.2 -> 0.169.0\r\n1. Update now");
  expect(statuses).toEqual(["blocked"]);
  expect(reports().at(-1)).toBe("attention codex-update-prompt");
  expect(ptys[0]!.writes).toEqual([]);
});

test("C-ATTN-11 work on screen clears the block to running", async () => {
  const { statuses, paint } = await start();
  await paint(tty(signIn));
  await vi.advanceTimersByTimeAsync(10_000);
  await paint(codexTty(working));
  expect(statuses).toEqual(["blocked", "running"]);
});

test("C-ATTN-11 Codex's header drawn alone while it loads is no unrecognized screen", async () => {
  const { statuses, paint, reports } = await start();
  await paint(tty(bootHeaderFrame));
  await vi.advanceTimersByTimeAsync(12_000);
  expect(statuses).toEqual([]);
  expect(reports()).toEqual([]);
  await paint(codexTty(codexComposer));
  await vi.advanceTimersByTimeAsync(500);
  expect(statuses).toEqual(["ready"]);
});

test("C-ATTN-11 a resize before the deadline that Codex does not repaint still blocks on time", async () => {
  const { session, statuses, activities, paint } = await start();
  await paint(tty(signIn));
  await vi.advanceTimersByTimeAsync(5_000);
  await session.resize({ cols: 40, rows: 30 });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(statuses).toEqual(["blocked"]);
  // The report holds the screen as the resize reflowed it.
  const reflowed = session.terminal.snapshot().text.trimEnd();
  expect(reflowed).not.toBe(signIn);
  expect(activities.find(({ kind }) => kind === "unrecognized_startup")).toMatchObject({
    label: "initial_ready_deadline",
    text: reflowed,
  });
});

test("C-ATTN-11 a status listener that throws on the block does not stop the report", async () => {
  const { session, statuses, reports, paint } = await start();
  session.on("status", () => {
    throw new Error("host listener failed");
  });
  await paint(tty(signIn));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(statuses).toEqual(["blocked"]);
  expect(reports()).toContain("unrecognized_startup initial_ready_deadline");
});

test("C-ATTN-11 after the first readiness no screen is an unrecognized startup screen", async () => {
  const { statuses, paint, reports } = await start();
  // The deadline passes on the boot composer, so readiness comes after it.
  await paint(codexTty(bootComposer));
  await vi.advanceTimersByTimeAsync(10_000);
  await paint(codexTty(codexComposer));
  await vi.advanceTimersByTimeAsync(500);
  expect(statuses).toEqual(["ready"]);
  await paint(tty(signIn));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(statuses).toEqual(["ready"]);
  expect(reports()).toEqual([]);
});
