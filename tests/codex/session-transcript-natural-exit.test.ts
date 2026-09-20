/** Shutdown during natural final flush joins exit without re-signaling (PRD §5.7, C-API-20). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test.each([
  "stop",
  "kill",
  "teardown",
] as const)("C-API-20 %s from final-flush transcript delivery joins a non-replayed natural exit", async (verb) => {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "rollout.jsonl");
  writeFileSync(path, "");
  const session = await startCodex({ cwd });
  let shutdown: Promise<void> | undefined;
  const finalized: string[] = [];
  session.on("terminal:exit", () => finalized.push("exit"));
  session.on("status", (event) => {
    if (["exited", "stopped", "killed"].includes(event.status)) finalized.push("status");
  });
  session.on("codex:transcript", () => {
    shutdown ??= session[verb]();
    for (const handler of [...ptys[0]!.exitHandlers]) handler({ exitCode: 7 });
  });
  const pty = ptys[0]!;
  try {
    await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
    // A real node-pty exit is not replayed when an already-exited PTY is signaled.
    pty.kill = (signal = "SIGTERM") => pty.killSignals.push(signal);
    appendFileSync(
      path,
      `${JSON.stringify({ type: "response_item", payload: { type: "reasoning" } })}\n`,
    );
    for (const handler of [...pty.exitHandlers]) handler({ exitCode: 0 });
    expect(shutdown).toBeDefined();
    await expect(shutdown).resolves.toBeUndefined();
    expect(finalized).toEqual(["exit", "status"]);
    expect(reapedGroups).toEqual([pty.pid]);
    expect(pty.killSignals).toEqual([]);
  } finally {
    await session.stop().catch(() => undefined);
  }
}, 15_000);
