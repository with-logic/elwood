/** Dashboard subagent edges through the real bridge handlers (C-STATS-02). */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type ElwoodActivityEvent, startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

function observedSubagents(session: {
  on(event: "activity", listener: (event: ElwoodActivityEvent) => void): unknown;
}) {
  const observations: unknown[] = [];
  session.on("activity", (event) => {
    if (event.subagent !== undefined) observations.push({ kind: event.kind, ...event.subagent });
  });
  return observations;
}

const expected = [
  { kind: "hook_result", id: "worker", type: "reviewer", state: "started" },
  { kind: "hook_result", id: "worker", type: "reviewer", state: "stopped" },
];

test("C-STATS-02 Claude reports a subagent stop after the allowing hook result", async () => {
  claude.installFakes();
  try {
    const cwd = claude.tempDir();
    const path = join(cwd, "agent.jsonl");
    writeFileSync(path, "");
    const session = await startClaude({
      cwd,
      hooks: {
        SubagentStop: (event) =>
          event.stop_hook_active ? undefined : { decision: "block", reason: "Finish review" },
      },
    });
    const events = observedSubagents(session);
    const call = (fields: object) =>
      claude.ptys[0]!.dispatchHook(session.elwoodSessionId, {
        session_id: "native",
        cwd,
        agent_id: "worker",
        agent_type: "reviewer",
        ...fields,
      });
    await call({ hook_event_name: "SubagentStart" });
    const stop = { hook_event_name: "SubagentStop", agent_transcript_path: path };
    const blocked = await call({ ...stop, stop_hook_active: false });
    expect(JSON.parse(blocked.stdout).decision).toBe("block");
    expect(events).toEqual(expected.slice(0, 1));
    await call({ ...stop, stop_hook_active: true });
    expect(events).toEqual(expected);
    await session.stop();
  } finally {
    claude.resetFakes();
  }
});

test("C-STATS-02 Codex reports a subagent stop after the allowing hook result", async () => {
  codex.installFakes();
  try {
    const cwd = codex.tempDir();
    const session = await startCodex({
      cwd,
      hooks: {
        SubagentStop: (event) =>
          event.stop_hook_active ? undefined : { decision: "block", reason: "Finish review" },
      },
    });
    const events = observedSubagents(session);
    const call = (fields: object) =>
      codex.ptys[0]!.dispatchHook(session.elwoodSessionId, {
        session_id: "native",
        turn_id: "turn",
        cwd,
        agent_id: "worker",
        agent_type: "reviewer",
        ...fields,
      });
    await call({ hook_event_name: "SubagentStart" });
    const stop = { hook_event_name: "SubagentStop" };
    const blocked = await call({ ...stop, stop_hook_active: false });
    expect(JSON.parse(blocked.stdout).decision).toBe("block");
    expect(events).toEqual(expected.slice(0, 1));
    await call({ ...stop, stop_hook_active: true });
    expect(events).toEqual(expected);
    await session.stop();
  } finally {
    codex.resetFakes();
  }
});
