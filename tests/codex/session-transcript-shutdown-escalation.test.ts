/** Exit-barrier coalescing retains higher-urgency shutdown effects (PRD §9.4, C-LIFE-10). */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-LIFE-10 teardown still removes files when queued behind final-flush stop and kill", async () => {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "transcript.jsonl");
  writeFileSync(path, "");
  const session = await startCodex({ cwd });
  const recordPath = join(cwd, ".elwood", "sessions", session.elwoodSessionId, "session.json");
  const requests: Promise<void>[] = [];
  session.on("codex:transcript", () => {
    for (const verb of ["stop", "kill", "teardown"] as const) requests.push(session[verb]());
  });
  const pty = ptys[0]!;
  try {
    await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
    expect(existsSync(recordPath)).toBe(true);
    pty.kill = (signal = "SIGTERM") => pty.killSignals.push(signal);
    writeFileSync(
      path,
      `${JSON.stringify({ type: "response_item", payload: { type: "reasoning" } })}\n`,
    );
    for (const handler of [...pty.exitHandlers]) handler({ exitCode: 0 });
    expect(requests).toHaveLength(3);
    await expect(Promise.all(requests)).resolves.toEqual([undefined, undefined, undefined]);
    expect(existsSync(recordPath)).toBe(false);
    expect(pty.killSignals).toEqual([]);
    expect(reapedGroups).toEqual([pty.pid]);
  } finally {
    await session.stop();
  }
});
