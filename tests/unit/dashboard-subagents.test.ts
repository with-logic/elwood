/** Dashboard subagent edges through the real bridge handlers (C-STATS-02). */
import { writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  type ElwoodActivityEvent,
  type ElwoodAgentSession,
  type SessionStats,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { readBridgeScript } from "../helpers/fake-pty.ts";
import { onlyLaunchArtifact } from "../helpers/launch-artifacts.ts";

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
  { kind: "hook_result", id: "worker", type: "reviewer", state: "started" },
  { kind: "hook_result", id: "worker", type: "reviewer", state: "stopped" },
];

test("C-STATS-02/04 Claude reports a subagent stop after the allowing hook result", async () => {
  claude.installFakes();
  let session: Awaited<ReturnType<typeof startClaude>> | undefined;
  try {
    const cwd = claude.tempDir();
    const path = join(cwd, "agent.jsonl");
    writeFileSync(path, "");
    const live = await startClaude({
      cwd,
      hooks: {
        SubagentStop: (event) =>
          event.stop_hook_active ? undefined : { decision: "block", reason: "Finish review" },
      },
    });
    session = live;
    const events = observedSubagents(live);
    const call = (fields: object) =>
      claude.ptys[0]!.dispatchHook(live.elwoodSessionId, {
        session_id: "native",
        cwd,
        agent_id: "worker",
        agent_type: "reviewer",
        ...fields,
      });
    await call({ hook_event_name: "SubagentStart" });
    await call({ hook_event_name: "SubagentStart" });
    expect((await live.getStats()).activeSubagentCount).toBe(1);
    await call({ hook_event_name: "SubagentStart", agent_id: "  " });
    const stop = { hook_event_name: "SubagentStop", agent_transcript_path: path };
    const blocked = await call({ ...stop, stop_hook_active: false });
    expect(JSON.parse(blocked.stdout).decision).toBe("block");
    expect(events).toEqual(expected.slice(0, 2));
    await call({ ...stop, stop_hook_active: true });
    expect(events).toEqual(expected);
    expect((await live.getStats()).activeSubagentCount).toBe(0);

    await call({ hook_event_name: "SubagentStart" });
    const pty = claude.ptys[0]!;
    const kill = pty.kill.bind(pty);
    let stopping: Promise<SessionStats> | undefined;
    let exited: Promise<SessionStats> | undefined;
    vi.spyOn(pty, "kill").mockImplementationOnce((signal) => {
      stopping = live.getStats();
      kill(signal);
    });
    live.on("terminal:exit", () => {
      exited = live.getStats();
    });
    await live.stop();
    expect((await stopping)?.activeSubagentCount).toBe(1);
    expect((await exited)?.activeSubagentCount).toBe(0);
  } finally {
    try {
      await session?.stop();
    } finally {
      claude.resetFakes();
    }
  }
});

test("C-STATS-02/04 Codex reports a subagent stop after the allowing hook result", async () => {
  codex.installFakes();
  let session: Awaited<ReturnType<typeof startCodex>> | undefined;
  try {
    const cwd = codex.tempDir();
    const live = await startCodex({
      cwd,
      hooks: {
        SubagentStop: (event) =>
          event.stop_hook_active ? undefined : { decision: "block", reason: "Finish review" },
      },
    });
    session = live;
    const events = observedSubagents(live);
    const call = (fields: object) =>
      codex.ptys[0]!.dispatchHook(live.elwoodSessionId, {
        session_id: "native",
        turn_id: "turn",
        cwd,
        agent_id: "worker",
        agent_type: "reviewer",
        ...fields,
      });
    await call({ hook_event_name: "SubagentStart" });
    await call({ hook_event_name: "SubagentStart" });
    expect((await live.getStats()).activeSubagentCount).toBe(1);
    await call({ hook_event_name: "SubagentStart", agent_id: "  " });
    const stop = { hook_event_name: "SubagentStop" };
    const blocked = await call({ ...stop, stop_hook_active: false });
    expect(JSON.parse(blocked.stdout).decision).toBe("block");
    expect(events).toEqual(expected.slice(0, 2));
    await call({ ...stop, stop_hook_active: true });
    expect(events).toEqual(expected);
    expect((await live.getStats()).activeSubagentCount).toBe(0);
  } finally {
    try {
      await session?.stop();
    } finally {
      codex.resetFakes();
    }
  }
});

test.each([
  ["Claude", claude, startClaude],
  ["Codex", codex, startCodex],
] as const)("C-STATS-02 %s omits late subagent starts after exit", async (_name, harness, start) => {
  harness.installFakes();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const result = Promise.withResolvers<ElwoodActivityEvent>();
  const cwd = harness.tempDir();
  let client: Socket | undefined;
  const session: ElwoodAgentSession = await start({
    cwd,
    hooks: {
      SubagentStart: async () => {
        entered.resolve();
        await release.promise;
      },
    },
  });
  try {
    session.on("activity", (event) => {
      if (event.kind === "hook_result" && event.hookEventName === "SubagentStart")
        result.resolve(event);
    });
    const { elwoodSessionId } = session;
    const sessionDir = join(cwd, ".elwood", "sessions", elwoodSessionId);
    const { socketPath, token } = readBridgeScript(onlyLaunchArtifact(sessionDir, "hook-bridge"));
    client = createConnection({ path: socketPath });
    await new Promise<void>((resolve, reject) => {
      client!.once("connect", resolve).once("error", reject);
    });
    client.resume();
    const input = JSON.stringify({
      hook_event_name: "SubagentStart",
      session_id: "native",
      turn_id: "turn",
      cwd,
      agent_id: "worker",
      agent_type: "reviewer",
    });
    client.write(`${JSON.stringify({ token, elwoodSessionId, input })}\n`);
    await entered.promise;
    await new Promise<void>((resolve) => {
      session.on("terminal:exit", () => resolve());
      harness.ptys[0]!.emitExit({ exitCode: 0 });
    });
    release.resolve();
    expect(await result.promise).not.toHaveProperty("subagent");
  } finally {
    client?.destroy();
    release.resolve();
    try {
      await session.stop();
    } finally {
      harness.resetFakes();
    }
  }
});
