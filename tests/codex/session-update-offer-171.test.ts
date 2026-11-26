/**
 * A Codex session skips the update offer that Codex 0.171 and later draw at start or on
 * resume, holds input through the screen Codex repaints after the skip, and only then
 * writes onto the configured composer. Codex 0.172 repaints its boot composer on a start
 * and its `Resuming session…` placeholder on a resume; no 0.171 start was captured after a
 * skip, so its rows repaint the resume placeholder. The frames are real npm 0.171.0 and
 * standalone 0.172.0 captures (PRD §5.3, §5.5, C-API-28, C-CODEX-27).
 */

import { afterEach, expect, test } from "vitest";
import { firstKeyDelayMs } from "../../src/codex/update-prompt.ts";
import {
  type CodexSessionApi,
  type ElwoodActivityEvent,
  type ElwoodActivityKind,
  resumeCodex,
  startCodex,
} from "../../src/index.ts";
import { codexTty, tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { becomeReady, installFakes, ptys, render, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

/** Each capture fills all 30 rows; a final newline would scroll the composer off its row. */
const frame = (capture: string) => capturedFrame(capture).trimEnd();
/** The size the captures were taken at, so the configured composer reads as Codex drew it. */
const initialSize = { cols: 100, rows: 30 };

const v171 = "codex-0.171.0/update";
const v172 = "codex-0.172.0/update";
const offer172 = `${v172}/offer-standalone-100x30`;
/** What Codex drew after the skip, in order, and then its configured composer. */
const repaintsAfterSkip = {
  "0.171 start": [[`${v171}/resume-placeholder`], `${v171}/resume-skipped-composer`],
  "0.171 resume": [[`${v171}/resume-placeholder`], `${v171}/resume-skipped-composer`],
  "0.172 start": [
    [`${v172}/start-boot-partial`, `${v172}/start-boot-composer`, `${v172}/start-notice-partial`],
    `${v172}/start-skipped-composer`,
  ],
  "0.172 resume": [
    [`${v172}/resume-placeholder`, `${v172}/resume-notice-partial`],
    `${v172}/resume-skipped-composer`,
  ],
} as const;

async function open(launch: "start" | "resume", size = initialSize) {
  const cwd = tempDir();
  installFakes();
  let session = await startCodex({ cwd, initialSize: size });
  if (launch === "resume") {
    await becomeReady(session.elwoodSessionId, cwd);
    await session.stop();
    session = await resumeCodex({
      cwd,
      initialSize: size,
      elwoodSessionId: session.elwoodSessionId,
    });
  }
  const activity: Pick<ElwoodActivityEvent, "kind" | "label">[] = [];
  session.on("activity", (event) => {
    activity.push({ kind: event.kind, label: event.label });
  });
  return { session, pty: ptys.at(-1)!, activity };
}

/** Enough for the first-key wait under a loaded parallel run. */
const firstKey = { timeout: firstKeyDelayMs + 4_500 };

/** Codex hides the cursor on the offer and shows it again in its composer. */
const showOffer = (session: CodexSessionApi, capture: string) =>
  render(session, `${tty(capturedFrame(capture))}\u001b[?25l`);

/**
 * Paints Codex's screens after the skip, then its configured composer. Returns the writes
 * as they stood before the configured composer.
 */
async function writesBeforeConfiguredComposer(
  session: CodexSessionApi,
  key: keyof typeof repaintsAfterSkip,
  writes: string[],
) {
  const [screens, configured] = repaintsAfterSkip[key];
  for (const screen of screens) await render(session, codexTty(frame(screen)));
  const beforeComposer = [...writes];
  await render(session, codexTty(frame(configured)));
  return beforeComposer;
}

/** The attention and startup_prompt labels a session announced. */
function announced(activity: readonly Pick<ElwoodActivityEvent, "kind" | "label">[]) {
  const labels = (kind: ElwoodActivityKind) =>
    activity.filter((event) => event.kind === kind).map((event) => event.label);
  return { attention: labels("attention"), startup_prompt: labels("startup_prompt") };
}

/** The offer is announced; Codex's repaint after it is the skip's, never an unknown dialog. */
const oneSkip = { attention: ["codex-update-prompt"], startup_prompt: ["update"] };

test.each([
  ["start", `${v171}/offer-npm`, "0.171 start"],
  ["resume", `${v171}/offer-npm`, "0.171 resume"],
  ["start", offer172, "0.172 start"],
  ["resume", offer172, "0.172 resume"],
] as const)("C-CODEX-27 a %s skips the %s offer before queued input", async (launch, capture, key) => {
  const { session, pty, activity } = await open(launch);
  try {
    const sent = session.sendMessage("queued at launch");
    sent.catch(() => {});
    await showOffer(session, capture);
    await expect.poll(() => pty.writes, firstKey).toEqual(["2"]);
    expect(await writesBeforeConfiguredComposer(session, key, pty.writes)).toEqual(["2"]);
    await sent;
    expect(pty.writes).toEqual(["2", "\u001b[200~queued at launch\u001b[201~", "\r"]);
    expect(announced(activity)).toEqual(oneSkip);
  } finally {
    await session.stop();
  }
});

test.each([
  ["sendPrompt", (session: CodexSessionApi) => session.sendPrompt("sent at launch"), "sent"],
  ["listModels", (session: CodexSessionApi) => session.listModels({ timeoutMs: 30_000 }), "/model"],
  [
    "setModel",
    (session: CodexSessionApi) => session.setModel("gpt-5.4", { timeoutMs: 30_000 }),
    "/model",
  ],
] as const)("C-API-28 a start holds %s through the offer and Codex's repaint", async (_, run, typed) => {
  const { session, pty, activity } = await open("start");
  try {
    const writing = run(session);
    writing.catch(() => {});
    await showOffer(session, offer172);
    await expect.poll(() => pty.writes, firstKey).toEqual(["2"]);
    expect(await writesBeforeConfiguredComposer(session, "0.172 start", pty.writes)).toEqual(["2"]);
    await expect.poll(() => pty.writes.slice(1).join("")).toContain(typed);
    expect(pty.writes[0]).toBe("2");
    expect(announced(activity)).toEqual(oneSkip);
  } finally {
    await session.stop();
  }
});

test.each([
  "start",
  "resume",
] as const)("C-CODEX-27 a %s skips once while the offer stays on Elwood's screen after the key", async (launch) => {
  const { session, pty, activity } = await open(launch);
  try {
    const sent = session.sendMessage("queued at launch");
    sent.catch(() => {});
    await showOffer(session, offer172);
    await expect.poll(() => pty.writes, firstKey).toEqual(["2"]);
    // Codex took the key at once; its output reaches Elwood a second later.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(pty.writes).toEqual(["2"]);
    expect(await writesBeforeConfiguredComposer(session, `0.172 ${launch}`, pty.writes)).toEqual([
      "2",
    ]);
    await sent;
    expect(pty.writes).toEqual(["2", "\u001b[200~queued at launch\u001b[201~", "\r"]);
    expect(announced(activity)).toEqual(oneSkip);
  } finally {
    await session.stop();
  }
});

test.each([
  [`${v171}/offer-npm-60x30`, 60],
  [`${v172}/offer-standalone-60x30`, 60],
  [`${v172}/offer-standalone-40x30`, 40],
] as const)("C-CODEX-27 a start at narrow width skips the %s offer once", async (capture, cols) => {
  const { session, pty } = await open("start", { cols, rows: 30 });
  try {
    const sent = session.sendMessage("queued at launch");
    sent.catch(() => {});
    await showOffer(session, capture);
    await expect.poll(() => pty.writes, firstKey).toEqual(["2"]);
    // Four retry intervals after the key, with the offer still on Elwood's screen.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(pty.writes).toEqual(["2"]);
  } finally {
    await session.stop();
  }
});

test("C-CODEX-12 a resize after the key, before Codex's next screen reaches Elwood, types no second key", async () => {
  const { session, pty } = await open("start");
  try {
    await showOffer(session, offer172);
    await expect.poll(() => pty.writes, firstKey).toEqual(["2"]);
    // Elwood's frame changes, but Codex has drawn nothing since the key.
    await session.resize({ cols: 100, rows: 32 });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(pty.writes).toEqual(["2"]);
  } finally {
    await session.stop();
  }
});
