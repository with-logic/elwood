/**
 * Conformance for the fallback initial-ready transition (PRD §5.3, §5.7, C-API-42):
 * when recording Claude's one-shot initial-ready transition throws, the control
 * queue is still released so queued input is never starved, and a bounded,
 * content-free `initial_ready_fallback` warning surfaces the stale-status risk.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { setRecordWriteFaultForTests } from "../../src/state/write-fault.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const ESC = String.fromCharCode(27);
const PASTE = `${ESC}[200~hello${ESC}[201~`;

afterEach(() => {
  setRecordWriteFaultForTests(undefined);
  resetFakes();
});

async function reachReady(cwd: string, id: string): Promise<void> {
  await ptys[0]!.dispatchHook(id, {
    hook_event_name: "InstructionsLoaded",
    session_id: "claude-1",
    cwd,
    file_path: "/tmp/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session_start",
  });
}

describe("ClaudeSession initial-ready fallback (C-API-42)", () => {
  test("C-API-42 a throwing ready-status listener still releases the queue and warns with reason=listener", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const queued = session.sendMessage("hello");
    // A rogue listener throws on the `ready` transition: recording initial-ready
    // fails at the EMIT stage (persistence already succeeded), so the queue must
    // still be released directly and the fallback reason must be `listener`.
    session.on("status", (event) => {
      if (event.status === "ready") throw new Error("rogue status listener");
    });
    await reachReady(cwd, session.elwoodSessionId);
    await queued;
    // Anti-starvation: the queued message was released despite the throw.
    expect(ptys[0]!.writes[0]).toBe(PASTE);
    const warning = session.warnings.find((w) => w.code === "initial_ready_fallback");
    expect(warning).toMatchObject({
      code: "initial_ready_fallback",
      agent: "claude",
      source: "lifecycle",
      reason: "listener",
    });
    expect(warning?.raw).toBe("initial_ready_fallback reason=listener");
  });

  test("C-API-42 a failing durable status write releases the queue and warns with reason=persist", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const queued = session.sendMessage("hello");
    // Startup (`startup_usable`) has already persisted cleanly; arm the fault to
    // fail ONLY writes of the `ready` record — the initial-ready status write AND
    // the classifying re-persist (both carry status `ready`) — while the later
    // message-drain `running`/turn writes still succeed. The recorded reason is
    // `persist`, and the queue is still released so input is not starved.
    setRecordWriteFaultForTests((record) => {
      if (record.status === "ready")
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    await reachReady(cwd, session.elwoodSessionId);
    await queued;
    expect(ptys[0]!.writes[0]).toBe(PASTE);
    // The record is unwritable, but `persist` updates the in-memory record before
    // the disk write throws, so the warning is still observable on live warnings.
    const warning = session.warnings.find((w) => w.code === "initial_ready_fallback");
    expect(warning).toMatchObject({ code: "initial_ready_fallback", reason: "persist" });
  });

  test("C-API-42 a throwing WARNING sink during fallback delivery cannot re-starve the queue", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const queued = session.sendMessage("hello");
    session.on("status", (event) => {
      if (event.status === "ready") throw new Error("rogue status listener");
    });
    // A second rogue listener throws while DELIVERING the fallback warning; the
    // queue release already happened first, so the message is never starved.
    session.on("warning", () => {
      throw new Error("rogue warning sink");
    });
    await reachReady(cwd, session.elwoodSessionId);
    await queued;
    expect(ptys[0]!.writes[0]).toBe(PASTE);
  });
});
