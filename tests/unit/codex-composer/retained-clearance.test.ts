/** Real terminal provenance for retained update clearance (intended C-CODEX-12 wiring). */
import { expect, test } from "vitest";
import { liveCodexClearance } from "../../../src/codex/screen/live-clearance.ts";
import { CodexRetainedComposerHold } from "../../../src/codex/screen/retained-clearance.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { codexComposer, codexSmallComposer, codexTty } from "../../fixtures/trust-composer.ts";

const update = "Update available! 0.151.0 -> 0.152.0";
const history = "• Earlier menu example:\n  ❯ Proceed\n    Cancel\n\n1. First step\n2. Second step";
const idle = `\n\n\n\n\n${history}\n${codexSmallComposer}`;
function fixture() {
  const terminal = createHeadlessTerminal({ cols: 100, rows: 30 }, () => undefined);
  const hold = new CodexRetainedComposerHold(liveCodexClearance(() => terminal));
  return {
    terminal,
    read: (active = false) => hold.observe(terminal.snapshot().text, active),
    paint: (text: string) => terminal.writeOutput(`\u001b[2J\u001b[H${codexTty(text)}`),
    overlay: (text: string) =>
      terminal.writeOutput(`\u001b7\u001b[H\u001b[2K${text.replaceAll("\n", "\r\n")}\u001b8`),
  };
}

test.each([
  "Confirm archive removal?",
  "Confirm archive removal?\n❯ Proceed\n  Cancel",
])("C-CODEX-12 continuously visible old composer rejects replacement %s", async (replacement) => {
  const f = fixture();
  try {
    await f.paint(idle);
    expect(f.read()).toBe(false);
    await f.overlay(update);
    expect(f.read(true)).toBe(true);
    await f.overlay(replacement);
    await f.terminal.writeOutput("\u001b7\u001b[1;1H\u001b[?25l");
    expect(f.read()).toBe(true);
    await f.terminal.writeOutput("\u001b8\u001b[?25h");
    for (let repeat = 0; repeat < 3; repeat++) expect(f.read()).toBe(true);
    // Repeated observations cannot adopt the replacement as legitimate history.
    await f.paint(idle);
    expect(f.read()).toBe(false);
  } finally {
    f.terminal.dispose();
  }
});

test.each([
  "Confirm archive removal?\n❯ Proceed\n  Cancel",
  "› Explain this codebase\n• Previously submitted prompt\nConfirm archive removal?\n❯ Proceed",
])("C-CODEX-12 full replacement retires the old composer before new resume history: %s", async (replacement) => {
  const f = fixture();
  try {
    await f.paint(idle);
    expect(f.read()).toBe(false);
    await f.overlay(update);
    expect(f.read(true)).toBe(true);
    await f.paint(replacement);
    expect(f.read()).toBe(true);
    await f.paint(`• Newly loaded resumed reply\n${history}\n${codexSmallComposer}`);
    expect(f.read()).toBe(false);
  } finally {
    f.terminal.dispose();
  }
});

test("C-CODEX-12 startup update without a prior composer allows newly loaded history", async () => {
  const f = fixture();
  try {
    await f.paint(update);
    expect(f.read(true)).toBe(true);
    await f.paint(idle);
    await f.terminal.writeOutput("\u001b[?25l");
    expect(f.read()).toBe(true);
    await f.terminal.writeOutput("\u001b[?25h");
    expect(f.read()).toBe(false);
  } finally {
    f.terminal.dispose();
  }
});

test("C-CODEX-12 an unverified composer at update entry stays held until replacement", async () => {
  const f = fixture();
  try {
    await f.paint(`${update}\n${codexSmallComposer}`);
    expect(f.read(true)).toBe(true);
    await f.paint(codexSmallComposer);
    expect(f.read()).toBe(true);
    await f.paint("");
    expect(f.read()).toBe(true);
    await f.paint(codexSmallComposer);
    expect(f.read()).toBe(false);
  } finally {
    f.terminal.dispose();
  }
});

test("C-CODEX-12 scrolling may trim prior history but cannot add replacement rows", async () => {
  const f = fixture();
  try {
    await f.paint(idle);
    expect(f.read()).toBe(false);
    await f.overlay(update);
    expect(f.read(true)).toBe(true);
    await f.paint(codexSmallComposer);
    expect(f.read()).toBe(false);
    await f.overlay(update);
    expect(f.read(true)).toBe(true);
    await f.paint(`New replacement header\n${codexSmallComposer}`);
    expect(f.read()).toBe(true);
  } finally {
    f.terminal.dispose();
  }
});

test("C-CODEX-12 unrelated frames cannot start a hold or preserve an absent old composer", async () => {
  const f = fixture();
  try {
    await f.paint(idle);
    expect(f.read()).toBe(false);
    await f.terminal.writeOutput("\u001b[?25l");
    expect(f.read()).toBe(false);
    await f.paint("unrelated non-composer frame");
    expect(f.read()).toBe(false);
    await f.paint(`${update}\n${codexSmallComposer}`);
    expect(f.read(true)).toBe(true);
    await f.paint(codexSmallComposer);
    expect(f.read()).toBe(true);
  } finally {
    f.terminal.dispose();
  }
});

test("C-CODEX-12 equal-height replacement cannot reuse the old composer's prelude", async () => {
  const f = fixture();
  try {
    await f.paint(idle);
    expect(f.read()).toBe(false);
    await f.overlay(update);
    expect(f.read(true)).toBe(true);
    await f.paint(idle.replace("• Earlier menu example:", "Confirm archive removal?"));
    expect(f.read()).toBe(true);
    await f.paint(idle);
    expect(f.read()).toBe(false);
  } finally {
    f.terminal.dispose();
  }
});

test("C-CODEX-12 a cursor-hidden welcome transcript cannot preserve the old composer", async () => {
  const f = fixture();
  const welcomeTranscript = `${codexComposer.slice(0, codexComposer.lastIndexOf("\n›"))}\n› Explain this codebase`;
  try {
    await f.paint(idle);
    expect(f.read()).toBe(false);
    await f.overlay(update);
    expect(f.read(true)).toBe(true);
    await f.paint(welcomeTranscript);
    await f.terminal.writeOutput("\u001b[?25l");
    expect(f.read()).toBe(true);
    await f.paint(`• Newly loaded resumed reply\n${history}\n${codexSmallComposer}`);
    expect(f.read()).toBe(false);
  } finally {
    f.terminal.dispose();
  }
});

test("C-CODEX-12 a live welcome-only composer releases the startup update hold", async () => {
  const f = fixture();
  const welcome = codexComposer.slice(0, codexComposer.lastIndexOf("\n"));
  try {
    await f.paint(update);
    expect(f.read(true)).toBe(true);
    await f.paint(welcome);
    await f.terminal.writeOutput("\u001b[?25l");
    expect(f.read()).toBe(true);
    await f.terminal.writeOutput("\u001b[?25h");
    expect(f.read()).toBe(false);
  } finally {
    f.terminal.dispose();
  }
});
