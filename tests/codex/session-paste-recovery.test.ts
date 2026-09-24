/** Codex recovery checks the sanitized, rendered paste (PRD §5.3, C-API-31/40). */
import { afterEach, expect, test, vi } from "vitest";
import { startCodex } from "../../src/index.ts";
import { codexSmallComposer, codexTty } from "../fixtures/trust-composer.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

test.each([
  ["C0/C1 controls", "a\u0001b\u0085c", "abc", "abc"],
  ["paste sentinel", "a\u001b[201~b", "a[201~b", "a[201~b"],
  ["tab", "a\tb", "a\tb", "a b"],
  ["offset tabs", "aaaa\t\tb", "aaaa\t\tb", "aaaa  b"],
  ["multiline tab", "first\nlast\tword", "first\nlast\tword", "last word"],
  ["carriage return", "first\rlast", "first\rlast", "last"],
  ["CRLF", "first\r\nlast", "first\r\nlast", "last"],
])("C-API-31/40 %s still staged in Codex receives a recovery Enter", async (_case, prompt, payload, rendered) => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  const pty = ptys[0]!;
  const paint = (text: string) => `\u001b[2J\u001b[H${codexTty(text)}`;
  const draft = codexSmallComposer.replace("› Ask Codex to do anything", `› ${rendered}`);
  const write = pty.write.bind(pty);
  vi.spyOn(pty, "write").mockImplementation((data) => {
    write(data);
    if (String(data).startsWith("\u001b[200~")) pty.emitData(paint(draft));
    // The fake CLI drops the first Enter and keeps the native draft visible.
  });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    vi.useFakeTimers();
    const sent = session.sendPrompt(prompt);
    void sent.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(500);
    await sent;
    expect(pty.writes).toEqual([`\u001b[200~${payload}\u001b[201~`, "\r"]);
    expect(session.terminal.snapshot().text).toContain(rendered);
    // A fresh native repaint, not the cached pre-Enter draft, authorizes recovery.
    pty.emitData(paint(draft));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pty.writes).toEqual([`\u001b[200~${payload}\u001b[201~`, "\r", "\r"]);
    pty.emitData(paint(codexSmallComposer));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pty.writes.filter((data) => data === "\r")).toHaveLength(2);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
