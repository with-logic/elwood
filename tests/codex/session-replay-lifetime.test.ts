/** Private turn replay uses physical submission evidence (PRD §5.8). */
import { afterEach, expect, test } from "vitest";
import { cancellableSubmission } from "../../src/core/input/submission-cancel.ts";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("Private replay: cancelling a queued replay leaves the real session ready for another message", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const abort = new AbortController();
    const replay = session.sendMessage("replay", cancellableSubmission(undefined, abort.signal));
    const rejected = expect(replay).rejects.toThrow("Turn replay cancelled");
    abort.abort();
    await rejected;
    expect(session.status).toBe("ready");
    expect(ptys[0]!.writes).not.toContain("\r");
    await session.sendMessage("next");
    expect(ptys[0]!.writes).toContain("\u001b[200~next\u001b[201~");
    expect(session.status).toBe("running");
  } finally {
    await session.stop();
  }
});

test("Private replay: a replay reports running when its first Enter dispatches", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const abort = new AbortController();
    const replay = session.sendMessage("replay", cancellableSubmission({}, abort.signal));
    const rejected = expect(replay).rejects.toThrow("Turn replay cancelled");
    expect(session.status).toBe("ready");
    await expect.poll(() => ptys[0]!.writes.includes("\r")).toBe(true);
    expect(session.status).toBe("running");
    abort.abort();
    await rejected;
    expect(ptys[0]!.writes.filter((write) => write === "\r")).toHaveLength(1);
  } finally {
    await session.stop();
  }
});
