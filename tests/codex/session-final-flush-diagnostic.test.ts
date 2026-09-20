/** Final-flush diagnostics join natural exit before reentrant stop (C-API-20, §5.7). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  type CodexHookBridgeFactory,
  currentCodexHookBridgeFactory,
  setCodexHookBridgeFactoryForTests,
} from "../../src/codex/session/bridge.ts";
import { BoundedTranscriptCursor } from "../../src/core/transcript/cursor.ts";
import { startCodex } from "../../src/index.ts";
import { installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test.each([
  false,
  true,
])("C-API-20 final-flush diagnostic stop preserves ordering (startup gate open=%s)", async (open) => {
  installFakes();
  const factory = currentCodexHookBridgeFactory();
  let dispatch!: Parameters<CodexHookBridgeFactory>[3];
  setCodexHookBridgeFactoryForTests((...args) => {
    dispatch = args[3];
    return factory(...args);
  });
  const cwd = tempDir();
  const path = join(cwd, "transcript.jsonl");
  writeFileSync(path, "");
  const session = await startCodex({ cwd });
  const pty = ptys[0]!;
  let stopped: Promise<void> | undefined;
  const order: string[] = [];
  try {
    // Invoke the real captured handler without an I/O turn, so the startup
    // warning gate can remain closed while a real transcript path is observed.
    await dispatch({
      hook_event_name: "SessionStart",
      session_id: "native-1",
      cwd,
      model: "model",
      source: "startup",
      transcript_path: path,
    });
    if (open) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    session.on("activity", (event) => {
      if (event.source === "transcript") order.push("transcript");
      if (event.kind === "warning") order.push("warning:activity");
    });
    session.on("warning", (warning) => {
      if (warning.code !== "transcript_poll_stopped") return;
      expect(warning.phase).toBe("final_flush");
      order.push("warning");
      stopped ??= session.stop();
    });
    session.on("terminal:exit", () => order.push("exit"));
    session.on("status", ({ status }) => {
      if (["exited", "stopped", "killed"].includes(status)) order.push("status");
    });
    appendFileSync(path, '{"type":"response_item","payload":{"type":"reasoning"}}\n');
    // Fail the internal final-partial drain after the real record has been read.
    // Public listener throws are isolated by C-CODEX-20 and cannot stand in for this error.
    const drain = vi
      .spyOn(BoundedTranscriptCursor.prototype, "drainPending")
      .mockImplementationOnce(() => {
        throw new Error("private internal cursor failure");
      });
    pty.emitExit({ exitCode: 0 });
    await expect.poll(() => stopped !== undefined).toBe(true);
    await expect(stopped).resolves.toBeUndefined();
    expect(order).toEqual(["transcript", "warning", "warning:activity", "exit", "status"]);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(pty.killSignals).toEqual([]);
    expect(reapedGroups).toEqual([pty.pid]);
  } finally {
    await session.stop().catch(() => undefined);
  }
});
