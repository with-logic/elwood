/** Captured Codex warning/agents footers clear trust only at live idle (C-TRUST-01/C-API-28). */
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import {
  codexComposerClearance,
  codexComposerConfigured,
} from "../../src/codex/screen/clearance.ts";
import { startCodex } from "../../src/index.ts";
import { codexTty } from "../fixtures/trust-composer.ts";
import { asScreen } from "../helpers/model-pickers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const captured = readFileSync(
  new URL("../fixtures/codex-0.159.2/warning-composer.txt", import.meta.url),
  "utf8",
);
const trust = readFileSync(
  new URL("../fixtures/codex-0.154.0/directory.txt", import.meta.url),
  "utf8",
);
const agents = readFileSync(
  new URL("../fixtures/codex-0.167.0/agents-footer.txt", import.meta.url),
  "utf8",
);
const paint = (text: string, visible = true) => `\u001b[2J\u001b[H${codexTty(text, visible)}`;

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test("C-TRUST-01 captured warning footer requires native chrome and an exact suffix", () => {
  expect(codexComposerClearance(captured)).toBe(true);
  expect(codexComposerClearance(captured.replace("3 warnings", "1 warning"))).toBe(true);
  expect(codexComposerClearance(captured.replace("3 warnings", "10 warnings"))).toBe(true);
  for (const suffix of ["0 warnings", "three warnings", "3 warnings · press Enter", "3 alerts"])
    expect(codexComposerClearance(captured.replace("3 warnings", suffix))).toBe(false);
  expect(codexComposerClearance(`${captured}\n1. Yes\n2. No`)).toBe(false);
  expect(codexComposerClearance(captured.replace(/ {2}gpt-[^\n]+\n/, ""))).toBe(false);
  expect(codexComposerClearance(`Would you like to run the following command?\n${captured}`)).toBe(
    false,
  );
});

test.each([
  { label: "warning counter", frame: agents },
  { label: "no warning counter", frame: agents.replace(/ +⚠ 3 warnings · f2 to view/, "") },
])("C-API-28 C-TRUST-01 accepts the captured agents hint with $label", ({ frame }) => {
  expect(codexComposerConfigured(frame)).toBe(true);
  expect(codexComposerClearance(frame)).toBe(true);
});

test.each([
  "for agents",
  "← for agents",
  "← for agents -",
  "← for agents · extra",
])("C-API-28 C-TRUST-01 rejects malformed agents hint %s", (hint) => {
  const frame = agents.replace("← for agents ·", hint);
  expect(codexComposerConfigured(frame)).toBe(false);
  expect(codexComposerClearance(frame)).toBe(false);
});

test("C-API-28 C-TRUST-01 agents hint retains warning, chrome, and dialog guards", () => {
  expect(codexComposerClearance(agents.replace("3 warnings", "3 warnings · press Enter"))).toBe(
    false,
  );
  expect(codexComposerClearance(agents.replace(/ {2}gpt-[^\n]+\n/, ""))).toBe(false);
  expect(codexComposerClearance(`Would you like to run the following command?\n${agents}`)).toBe(
    false,
  );
});

test.each([
  { label: "Codex 0.159.2 warning footer", frame: captured },
  { label: "Codex 0.167.0 agents footer", frame: agents },
])("C-API-28 $label releases deferred trust readiness, not hidden or dialog frames", async ({
  frame,
}) => {
  installFakes();
  const session = await startCodex({
    cwd: tempDir(),
    autotrust: true,
    initialSize: { cols: 220, rows: 35 },
  });
  const queued = session.sendMessage("after trust");
  // Teardown rejects pending input if an assertion fails.
  void queued.catch(() => undefined);
  try {
    vi.useFakeTimers();
    const pty = ptys[0]!;
    pty.emitData(asScreen(trust));
    await vi.advanceTimersByTimeAsync(10_500);
    expect(session.status).toBe("blocked");
    expect(pty.writes).not.toContain("\u001b[200~after trust\u001b[201~");
    pty.emitData(paint(frame, false));
    await vi.advanceTimersByTimeAsync(100);
    expect(session.status).toBe("blocked");
    pty.emitData(paint(frame.replace("3 warnings", "3 warnings · press Enter")));
    await vi.advanceTimersByTimeAsync(100);
    expect(session.status).toBe("blocked");
    pty.emitData(paint(`Would you like to run the following command?\n${frame}`));
    await vi.advanceTimersByTimeAsync(100);
    expect(session.status).toBe("blocked");
    pty.emitData(`\u001b[?2026h${paint(frame)}`);
    await vi.advanceTimersByTimeAsync(100);
    expect(session.status).toBe("blocked");
    expect(pty.writes).not.toContain("\u001b[200~after trust\u001b[201~");
    pty.emitData("\u001b[?2026l");
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.writes).toContain("\u001b[200~after trust\u001b[201~");
    await queued;
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
