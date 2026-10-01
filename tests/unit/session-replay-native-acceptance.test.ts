/** Both session adapters retain replay until a fresh native input frame (C-API-56). */
import { afterEach, expect, test, vi } from "vitest";
import { cancellableSubmission } from "../../src/core/input/submission-cancel.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { readNativeInputFrame } from "../fixtures/native-input-frame.ts";
import {
  claudeComposer,
  claudeTty,
  codexSmallComposer,
  codexTty,
} from "../fixtures/trust-composer.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});

test.each([
  { agent: "claude", nativeHook: false, payload: "" },
  { agent: "codex", nativeHook: false, payload: "" },
  { agent: "claude", nativeHook: true, payload: " \t\n" },
  { agent: "codex", nativeHook: true, payload: " \t\n" },
] as const)("C-API-56 $agent replay awaits empty input after nativeHook=$nativeHook", async ({
  agent,
  nativeHook,
  payload,
}) => {
  const helper = agent === "claude" ? claude : codex;
  helper.installFakes();
  const version = agent === "claude" ? "2.1.281" : "0.156.1";
  const frame = readNativeInputFrame(
    new URL(`../fixtures/${agent}-${version}/working-empty-input.json`, import.meta.url),
  );
  const cwd = helper.tempDir();
  const session = await (agent === "claude" ? startClaude : startCodex)({
    cwd,
    initialSize: { cols: 200, rows: frame.rows },
  });
  const pty = helper.ptys[0]!;
  const abort = new AbortController();
  const paint = async (text: string) => {
    pty.emitData(
      `\u001b[2J\u001b[H${text.replaceAll("\n", "\r\n")}\u001b[${frame.cursorY + 1};${frame.cursorX + 1}H\u001b[?25${frame.visible ? "h" : "l"}\u001b]0;${frame.title}\u0007`,
    );
    await vi.advanceTimersByTimeAsync(1);
  };
  try {
    if (agent === "claude")
      await pty.dispatchHook(session.elwoodSessionId, {
        hook_event_name: "InstructionsLoaded",
        session_id: "claude-1",
        cwd,
        file_path: "/tmp/CLAUDE.md",
        memory_type: "Project",
        load_reason: "session_start",
      });
    else await codex.becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    vi.useFakeTimers();
    let accepted = false;
    const replay = session.sendMessage(payload, cancellableSubmission(undefined, abort.signal));
    void replay.then(
      () => {
        accepted = true;
      },
      () => undefined,
    );
    await vi.advanceTimersByTimeAsync(150);
    const caret = agent === "claude" ? "❯" : "›";
    const idle = agent === "claude" ? claudeComposer : codexSmallComposer;
    const draft = idle.replace(new RegExp(`^${caret}.*$`, "m"), `${caret} [Image #1]`);
    const paintDraft = () =>
      pty.emitData(`\u001b[2J\u001b[H${(agent === "claude" ? claudeTty : codexTty)(draft)}`);
    paintDraft();
    await vi.advanceTimersByTimeAsync(1);
    if (nativeHook) {
      const stagedFrame = session.terminal.snapshot().text;
      await pty.dispatchHook(session.elwoodSessionId, {
        hook_event_name: "UserPromptSubmit",
        session_id: `${agent}-1`,
        cwd,
        model: "gpt-5.3-codex",
        turn_id: "turn-1",
        prompt: "",
      });
      expect(session.terminal.snapshot().text).toBe(stagedFrame);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(accepted).toBe(false);
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(1);
      paintDraft(); // even a fresh staged repaint cannot restore revoked Enter authority
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(accepted).toBe(false);
    expect(pty.writes.filter((value) => value === "\r")).toHaveLength(nativeHook ? 1 : 2);
    await paint(""); // a cleared or incomplete viewport is not acceptance
    await vi.advanceTimersByTimeAsync(1_000);
    expect(accepted).toBe(false);
    expect(pty.writes.filter((value) => value === "\r")).toHaveLength(nativeHook ? 1 : 2);
    await paint(frame.text); // actual native empty input while the turn is still active
    await vi.advanceTimersByTimeAsync(1_000);
    expect(accepted).toBe(true);
    await replay;
  } finally {
    abort.abort();
    vi.useRealTimers();
    await session.teardown();
  }
});

test("C-API-56 captured Codex whitespace-only input cannot release awaited replay", async () => {
  codex.installFakes();
  const frame = readNativeInputFrame(
    new URL("../fixtures/codex-0.159.2/whitespace-only-input.json", import.meta.url),
  );
  const empty = readNativeInputFrame(
    new URL("../fixtures/codex-0.156.1/working-empty-input.json", import.meta.url),
  );
  const cwd = codex.tempDir();
  const session = await startCodex({ cwd, initialSize: { cols: frame.cols, rows: frame.rows } });
  const pty = codex.ptys[0]!;
  const abort = new AbortController();
  const paint = (value: typeof frame) => {
    session.terminal.resize({ cols: value.cols, rows: value.rows });
    pty.emitData(
      `\u001b[2J\u001b[H${value.text.replaceAll("\n", "\r\n")}\u001b[${value.cursorY + 1};${value.cursorX + 1}H\u001b[?25${value.visible ? "h" : "l"}\u001b]0;${value.title}\u0007`,
    );
  };
  try {
    await codex.becomeReady(session.elwoodSessionId, cwd);
    vi.useFakeTimers();
    let accepted = false;
    const replay = session
      .sendMessage("  \t ", cancellableSubmission(undefined, abort.signal))
      .then(() => {
        accepted = true;
      });
    void replay.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(150);
    paint(frame);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(frame.text.split("\n")[frame.cursorY]).toBe("›");
    expect(frame.cursorX).toBe(6); // invisible staged spaces remain to the left of the caret
    expect(accepted).toBe(false);
    expect(pty.writes.filter((value) => value === "\r")).toHaveLength(2);
    const next = session.sendPrompt("next");
    void next.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pty.writes.some((value) => value.includes("next"))).toBe(false);
    paint(empty);
    await vi.advanceTimersByTimeAsync(1_200);
    await replay;
    await next;
    expect(accepted).toBe(true);
  } finally {
    abort.abort();
    vi.useRealTimers();
    await session.teardown();
  }
});
