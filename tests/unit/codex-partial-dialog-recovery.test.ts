/** Partial approval repaints must not authorize recovery input (PRD §5.3/§5.4, C-API-31/C-TRUST-01). */
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { codexEmptyInputFrame } from "../../src/codex/screen/empty-input.ts";
import { codexInputStaged } from "../../src/codex/screen/staged-input.ts";
import { codexTrustClearance } from "../../src/codex/screen-table.ts";
import { startCodex } from "../../src/index.ts";
import * as codex from "../codex/helpers.ts";
import { codexSmallComposer, codexTty } from "../fixtures/trust-composer.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  codex.resetFakes();
});

// Captured 0.156.1 native choices, isolated to model a header still painting.
const nativeChoices = readFileSync(
  new URL("../fixtures/codex-0.156.1/folder-access.txt", import.meta.url),
  "utf8",
)
  .split("\n")
  .slice(6, 8)
  .join("\n");
// Same native numbered grammar with the second option selected; not a new capture.
const secondChoice = nativeChoices.replace("› 1.", "  1.").replace("  2.", "› 2.");
// Existing partial-dialog fixture from codex-composer/clearance.test.ts.
const partial = "  Allow command?\n  1. Yes";
const fragments = [
  nativeChoices,
  secondChoice,
  partial,
  "Is this plugin source one you trust?",
  "Is this plugin source one you trust?\n❯ Yes, run plugins",
  "Is this plugin source one you trust?\n❯ Run plugins\n  Cancel",
  "❯ Proceed\n  Cancel",
  "› Proceed\n  Cancel",
  "› Earlier user prompt\n\n• Prior reply\n› Proceed\n  Cancel",
  "  1. Yes, proceed\n  2. No",
  "› 1. Yes, proceed\n  2. No",
  `• Previous reply\n\n${partial}`,
  "• Previous reply\nAllow command?\n  1. Yes",
  `• Working (3s • esc to interrupt)\n${partial}`,
];
const full =
  "Would you like to run the following command?\n› 1. Yes\n  2. No\nPress enter to confirm or esc to cancel";

test.each([
  ...fragments.map((dialog) => ({ kind: dialog, payload: "probe", dialog, synchronized: false })),
  { kind: "complete-dialog", payload: "probe", dialog: full, synchronized: false },
  { kind: "pending-render", payload: "probe", dialog: partial, synchronized: true },
])("C-API-31 $kind cannot add a recovery Enter through actual queued input guards", async ({
  payload,
  dialog,
  synchronized,
}) => {
  codex.installFakes();
  const cwd = codex.tempDir();
  const session = await startCodex({ cwd, initialSize: { cols: 200, rows: 32 }, autotrust: false });
  const pty = codex.ptys[0]!;
  try {
    await codex.becomeReady(session.elwoodSessionId, cwd);
    vi.useFakeTimers();
    const sent = session.sendPrompt(payload);
    await vi.advanceTimersByTimeAsync(200);
    await sent;
    expect(pty.writes.filter((v) => v === "\r")).toHaveLength(1);
    const draft = codexSmallComposer.replace("› Ask Codex to do anything", `› ${payload}`);
    const frame = `${dialog}\n${draft}`;
    const row = frame.split("\n").findLastIndex((line) => line.startsWith("›"));
    // Two prompt-prefix columns (`› `), plus one for terminal coordinates.
    const column = payload.length + 3;
    pty.emitData(
      `${synchronized ? "\u001b[?2026h" : ""}\u001b[2J\u001b[H${codexTty(frame)}\u001b[${row + 1};${column}H`,
    );
    const rendered = session.terminal.settled();
    await vi.advanceTimersByTimeAsync(1);
    await rendered;
    const staged = codexInputStaged(session.terminal, payload);
    // Raw recovery observes at most four times, paced by its default 1s interval.
    await vi.advanceTimersByTimeAsync(4_100);
    const enters = pty.writes.filter((v) => v === "\r").length;
    expect({ staged, enters }).toEqual({ staged: false, enters: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pty.writes.filter((value) => value === "\r")).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});

test.each(
  fragments,
)("C-TRUST-01 empty-input observer rejects partial approval %s", async (partial) => {
  codex.installFakes();
  const cwd = codex.tempDir();
  const session = await startCodex({ cwd, initialSize: { cols: 200, rows: 32 }, autotrust: false });
  const pty = codex.ptys[0]!;
  try {
    await codex.becomeReady(session.elwoodSessionId, cwd);
    const frame = `${partial}\n${codexSmallComposer}`;
    pty.emitData(`\u001b[2J\u001b[H${codexTty(frame)}`);
    await session.terminal.settled();
    expect(codexTrustClearance(frame)).toBe(false);

    expect(codexEmptyInputFrame(session.terminal)).toBeUndefined();
  } finally {
    await session.teardown();
  }
});

test.each([
  "• An approval example:\n  Would you like to run the following command?\n  › 1. Yes\n  2. No",
  "• Earlier menu example:\n  ❯ Proceed\n    Cancel\n\n1. First step\n2. Second step",
  "› Explain this codebase\n\n• Here is the explanation.",
  "› Help me with\n  this codebase\n\n• Prior reply",
  "› Yes, proceed\n\n• Previous answer.",
  "› 1. Yes\n\n• Previous answer.",
  "› 2. No\n\n• Previous answer.",
  "1. Trust and continue\n2. Quit",
  "› 1. Trust and continue\n\n• Previous answer.",
  `• Quoted folder choices:\n${nativeChoices
    .split("\n")
    .map((row) => `  ${row}`)
    .join("\n")}`,
  "• Quoted native menu:\n  Is this plugin source one you trust?\n  ❯ Run plugins\n    Cancel",
])("C-API-31 live composer below ordinary history still permits recovery: %s", async (history) => {
  codex.installFakes();
  const cwd = codex.tempDir();
  const session = await startCodex({ cwd, initialSize: { cols: 200, rows: 32 } });
  const pty = codex.ptys[0]!;
  try {
    await codex.becomeReady(session.elwoodSessionId, cwd);
    vi.useFakeTimers();
    const sent = session.sendPrompt("probe");
    await vi.advanceTimersByTimeAsync(200);
    await sent;
    const frame = `${history}\n${codexSmallComposer.replace("› Ask Codex to do anything", "› probe")}`;
    const row = frame.split("\n").findLastIndex((line) => line.startsWith("›"));
    pty.emitData(`\u001b[2J\u001b[H${codexTty(frame)}\u001b[${row + 1};8H`);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(codexInputStaged(session.terminal, "probe")).toBe(true);
    expect(pty.writes.filter((v) => v === "\r")).toHaveLength(2);
    pty.emitData(`\u001b[2J\u001b[H${codexTty(`${history}\n${codexSmallComposer}`)}`);
    const rendered = session.terminal.settled();
    await vi.advanceTimersByTimeAsync(1);
    await rendered;
    expect(codexEmptyInputFrame(session.terminal)).toBeDefined();
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
