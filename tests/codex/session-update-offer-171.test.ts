/**
 * A Codex session skips the update offer that Codex 0.171 and later draw at start or on
 * resume, and only then writes queued input onto the configured composer. After the skip
 * the real CLI first returns to the unconfigured composer it drew before the offer. The
 * frames are real npm 0.171.0 and standalone 0.172.0 captures (PRD §5.3, §5.5, C-API-28,
 * C-CODEX-27).
 */

import { afterEach, expect, test } from "vitest";
import { unsafeWriteRetryMs } from "../../src/core/input/constants.ts";
import { type CodexSessionApi, resumeCodex, startCodex } from "../../src/index.ts";
import { codexTty, tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

/** Each capture fills all 30 rows; a final newline would scroll the composer off its row. */
const frame = (capture: string) => capturedFrame(capture).trimEnd();
/** The size the captures were taken at, so the configured composer reads as Codex drew it. */
const initialSize = { cols: 100, rows: 30 };

/** Paints a terminal frame on a cleared screen and gives any writer time to write. */
async function render(session: CodexSessionApi, text: string): Promise<void> {
  ptys.at(-1)!.emitData(`\u001b[2J\u001b[H${text}`);
  await session.terminal.settled();
  await new Promise((resolve) => setTimeout(resolve, unsafeWriteRetryMs * 2));
}

const v171 = "codex-0.171.0/update";
const v172 = "codex-0.172.0/update";
/** What Codex drew after the skip, in order, and then its configured composer. */
const after = {
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

async function open(launch: "start" | "resume") {
  const cwd = tempDir();
  installFakes();
  let session = await startCodex({ cwd, initialSize });
  if (launch === "resume") {
    await becomeReady(session.elwoodSessionId, cwd);
    await session.stop();
    session = await resumeCodex({ cwd, initialSize, elwoodSessionId: session.elwoodSessionId });
  }
  const activity: { kind: string; label?: string }[] = [];
  session.on("activity", (event) =>
    activity.push({ kind: event.kind, ...("label" in event ? { label: event.label } : {}) }),
  );
  return { session, pty: ptys.at(-1)!, activity };
}

test.each([
  ["start", `${v171}/offer-npm`, "0.171 start"],
  ["resume", `${v171}/offer-npm`, "0.171 resume"],
  ["start", `${v172}/offer-standalone-100x30`, "0.172 start"],
  ["resume", `${v172}/offer-standalone-100x30`, "0.172 resume"],
] as const)("C-CODEX-27 a %s skips the %s offer before queued input", async (launch, capture, key) => {
  const { session, pty, activity } = await open(launch);
  const [repaint, configured] = after[key];
  try {
    const sent = session.sendMessage("queued at launch");
    sent.catch(() => {});
    // Codex hides the cursor on the offer and shows it again in its composer.
    await render(session, `${tty(capturedFrame(capture))}\u001b[?25l`);
    await expect.poll(() => pty.writes).toEqual(["2"]);
    for (const text of repaint) {
      await render(session, codexTty(frame(text)));
      expect(pty.writes).toEqual(["2"]);
    }
    await render(session, codexTty(frame(configured)));
    await sent;
    expect(pty.writes).toEqual(["2", "\u001b[200~queued at launch\u001b[201~", "\r"]);
    // The offer is announced; Codex's repaint after it is the skip's, not a dialog nobody
    // recognized.
    expect(activity.filter((event) => event.kind === "attention")).toEqual([
      { kind: "attention", label: "codex-update-prompt" },
    ]);
    expect(activity.filter((event) => event.kind === "startup_prompt")).toEqual([
      { kind: "startup_prompt", label: "update" },
    ]);
  } finally {
    await session.stop();
  }
});

test.each([
  "start",
  "resume",
] as const)("C-CODEX-27 a %s skips once while the offer stays on Elwood's screen after the key", async (launch) => {
  const { session, pty, activity } = await open(launch);
  const [repaint, configured] = after[`0.172 ${launch}`];
  try {
    const sent = session.sendMessage("queued at launch");
    sent.catch(() => {});
    await render(session, `${tty(capturedFrame(`${v172}/offer-standalone-100x30`))}\u001b[?25l`);
    await expect.poll(() => pty.writes).toEqual(["2"]);
    // Codex took the key at once; its output reaches Elwood a second later.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(pty.writes).toEqual(["2"]);
    for (const text of repaint) await render(session, codexTty(frame(text)));
    await render(session, codexTty(frame(configured)));
    await sent;
    expect(pty.writes).toEqual(["2", "\u001b[200~queued at launch\u001b[201~", "\r"]);
    expect(activity.filter((event) => event.kind === "startup_prompt")).toHaveLength(1);
  } finally {
    await session.stop();
  }
});
