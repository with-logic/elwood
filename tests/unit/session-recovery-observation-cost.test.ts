/** Recovery observes live input without repeated viewport/payload work (C-API-31). */
import { afterEach, expect, test, vi } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
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

const scenarios = [
  { agent: "claude", kind: "cached-frame" },
  { agent: "codex", kind: "cached-frame" },
  { agent: "codex", kind: "placeholder" },
  { agent: "codex", kind: "normalized-payload" },
] as const;

test.each(scenarios)("C-API-31 $agent recovery respects $kind", async ({ agent, kind }) => {
  const helper = agent === "claude" ? claude : codex;
  helper.installFakes();
  const cwd = helper.tempDir();
  const session = await (agent === "claude" ? startClaude : startCodex)({
    cwd,
    initialSize: { cols: 200, rows: 35 },
  });
  const pty = helper.ptys[0]!;
  const idle = agent === "claude" ? claudeComposer : codexSmallComposer;
  const caret = agent === "claude" ? "❯" : "›";
  const tail = kind === "placeholder" ? "anything" : "probe";
  const payload =
    kind === "normalized-payload" ? `${"large prompt ".repeat(5_000)}\n${tail}` : tail;
  const text = agent === "claude" ? "[Pasted text #1 +15 lines]" : tail;
  const draft = idle.replace(new RegExp(`^${caret}.*$`, "m"), `${caret} ${text}`);
  const paint = (frame = draft, column = text.length + 3, visible = true) => {
    const row = frame.split("\n").findLastIndex((line) => line.startsWith(caret));
    pty.emitData(
      `\u001b[2J\u001b[H${(agent === "claude" ? claudeTty : codexTty)(frame)}\u001b[${row + 1};${column}H\u001b[?25${visible ? "h" : "l"}`,
    );
  };
  const write = pty.write.bind(pty);
  vi.spyOn(pty, "write").mockImplementation((value) => {
    write(value);
    if (String(value).startsWith("\u001b[200~")) paint();
  });
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
    const sent = session.sendPrompt(payload);
    await vi.advanceTimersByTimeAsync(200);
    await sent;
    const snapshots = vi.spyOn(session.terminal, "snapshot");
    let normalizations = 0;
    const trim = String.prototype.trim;
    vi.spyOn(String.prototype, "trim").mockImplementation(function (this: string) {
      if (String(this) === payload) normalizations += 1;
      return trim.call(this);
    });
    if (kind === "placeholder") paint(idle, 28);
    if (kind === "normalized-payload") paint(draft, text.length + 3, false);
    await vi.advanceTimersByTimeAsync(1_000);
    if (kind === "cached-frame") {
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(2);
      expect(snapshots).not.toHaveBeenCalled();
    } else if (kind === "placeholder") {
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(1);
    } else {
      expect(normalizations).toBe(0);
      paint();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(normalizations).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(normalizations).toBe(1);
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(3);
    }
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
