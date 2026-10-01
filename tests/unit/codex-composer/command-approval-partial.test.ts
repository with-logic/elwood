/** Captured command-approval fragments retain native row provenance (C-API-31/C-API-56/C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import * as codex from "../../codex/helpers.ts";
import { codexCommandApprovalRender } from "../../fixtures/codex-command-approval-render.ts";
import { composerFrame, withComposerSession } from "./session-fixture.ts";

const capturedTerminal = createHeadlessTerminal({ cols: 100, rows: 30 }, () => undefined);
await capturedTerminal.writeOutput(codexCommandApprovalRender);
const rows = capturedTerminal.snapshot().text.split("\n");
capturedTerminal.dispose();
const prelude = rows.findIndex((row) => row.startsWith("• Running"));
const header = rows.findIndex((row) => row.includes("Would you like to run"));
const selected = rows.findIndex((row) => row.startsWith("› 1."));
const footer = rows.findIndex((row) => row.includes("Press enter to confirm"));
if (prelude < 0 || header < 0 || selected < 0 || footer < 0)
  throw new Error("Missing captured rows");
const selectedRow = rows[selected];
const headerRow = rows[header];
if (selectedRow === undefined || headerRow === undefined)
  throw new Error("Missing captured header or selected option");
// Footer/choice erasure is controlled; captured row spacing is not rearranged.
const cases = [
  {
    name: "captured footerless menu",
    text: rows.slice(prelude, footer).join("\n"),
    allowed: false,
  },
  {
    name: "captured prelude through header with native blank rows",
    text: rows.slice(prelude, header + 1).join("\n"),
    allowed: false,
  },
  { name: "captured selected choice after header erasure", text: selectedRow, allowed: false },
  {
    name: "ordinary bounded assistant quotation",
    text: `• Example approval:\n${headerRow}\n  ${selectedRow}`,
    allowed: true,
  },
];
afterEach(() => {
  vi.useRealTimers();
  codex.resetFakes();
});
for (const payload of ["probe", ""]) {
  test.each(cases)(`C-API-31/C-API-56 ${payload || "empty"} $name`, async ({ text, allowed }) => {
    await withComposerSession(
      { autotrust: false, fakeTimers: true, submit: payload },
      async ({ pty, emit, settle, clear }) => {
        emit(composerFrame(text, payload), payload);
        await settle(1);
        const observedClear = clear(payload);
        await vi.advanceTimersByTimeAsync(4_100);
        const enters = pty.writes.filter((value) => value === "\r").length;
        expect(observedClear).toBe(allowed);
        if (payload && !allowed) expect(enters).toBe(1);
      },
    );
  });
}
