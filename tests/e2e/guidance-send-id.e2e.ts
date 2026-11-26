/**
 * Real Claude and Codex caller IDs on guidance written during a running turn (PRD §5.4,
 * C-API-70, C-API-71). Both CLIs fire the guidance's `UserPromptSubmit` under the running
 * turn's ID: Claude as it queues the note, its composer empty under the working footer or the
 * queued-messages placeholder, and Codex as it steers the turn. A hook that matches the pending
 * guidance exactly carries its `sendId`, and a later send keeps its own. Guidance changed in
 * the composer carries none.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  type ElwoodActivityEvent,
  type ElwoodAgentSession,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import {
  type AgentName,
  cleanup,
  makeProject,
  skipIf,
  skipReason,
  skipTurns,
  waitFor,
} from "./helpers.ts";

const criterion = { claude: "C-API-71", codex: "C-API-70" } as const;
const toolTurn = {
  claude: "Use the Bash tool to run `sleep 12`. Then reply with the single word: done.",
  codex: "Run the shell command `sleep 12` and then reply with the single word: done.",
} as const;
type UserMessage = Extract<ElwoodActivityEvent, { kind: "user_message" }>;

/** A session inside a running tool turn, and its hook-sourced `user_message` for some text. */
async function runningToolTurn(agent: AgentName) {
  const project = makeProject(agent);
  const base = { cwd: project.cwd, stateDir: project.stateDir, autotrust: true };
  const session =
    agent === "claude"
      ? await startClaude({ ...base, permissionMode: "bypassPermissions" })
      : await startCodex({ ...base, sandbox: "read-only", approvalPolicy: "never" });
  const messages: UserMessage[] = [];
  let toolCalled = false;
  const find = (text: string) => messages.find((message) => message.text.includes(text));
  try {
    const observed: ElwoodAgentSession = session;
    observed.on("activity", (event) => {
      if (event.kind === "user_message" && event.source === "hook") messages.push(event);
      if (event.kind === "tool_call") toolCalled = true;
    });
    await waitFor(() => (session.status === "ready" ? true : undefined), "initial ready", 90_000);
    await session.sendMessage(toolTurn[agent], { sendId: "turn" });
    // The turn keeps running for the `sleep 12` this tool call starts.
    await waitFor(() => (toolCalled ? true : undefined), "the running tool call", 60_000);
    const shown = (text: string) => session.terminal.snapshot().text.includes(text);
    return {
      session,
      heard: (text: string) => waitFor(() => find(text), text, 60_000),
      painted: (text: string) => waitFor(() => (shown(text) ? true : undefined), text, 10_000),
    };
  } catch (error) {
    await cleanup(session);
    throw error;
  }
}

for (const agent of ["claude", "codex"] as const) {
  const options = { skip: skipIf(skipReason(agent), skipTurns), timeout: 240_000 };
  const id = criterion[agent];

  test(
    `${id} real ${agent} associates guidance written during a turn with its caller ID`,
    options,
    async () => {
      const { session, heard, painted } = await runningToolTurn(agent);
      const first = "Coordinator note one: also say ALPHA.";
      const second = "Coordinator note two: also say BRAVO.";
      const after = "Reply with the single word: three. Do not use tools.";
      try {
        await session.sendGuidance(first, { sendId: "guidance-1" });
        await heard(first);
        // Claude queues the first note, and the second is written under its placeholder.
        if (agent === "claude") await painted("Press up to edit queued messages");
        await session.sendGuidance(second, { sendId: "guidance-2" });
        await heard(second);
        await waitFor(() => (session.status === "ready" ? true : undefined), "ready", 120_000);
        await session.sendMessage(after, { sendId: "after" });
        const turnId = (await heard(toolTurn[agent])).turnId;
        const api = { origin: "api", input: "pasted" };
        const one = await heard(first);
        assert.equal(one.turnId, turnId, "guidance-1's hook reuses the running turn's ID");
        assert.equal(one.sendId, "guidance-1", "guidance-1 carries its caller ID");
        assert.deepEqual(one.promptProvenance, api, "guidance-1 is api input");
        const two = await heard(second);
        assert.equal(two.turnId, turnId, "guidance-2's hook reuses the running turn's ID");
        assert.equal(two.sendId, "guidance-2", "guidance-2 carries its caller ID");
        assert.deepEqual(two.promptProvenance, api, "guidance-2 is api input");
        const later = await heard(after);
        assert.equal(later.sendId, "after", "a later send keeps its own caller ID");
        assert.notEqual(later.turnId, turnId);
      } finally {
        await cleanup(session);
      }
    },
  );

  test(
    `${id} real ${agent} guidance changed in the composer carries no caller ID`,
    options,
    async () => {
      const { session, heard } = await runningToolTurn(agent);
      const note = "Coordinator note: also say CHARLIE.";
      try {
        await session.sendKeys("Edited. ");
        await session.sendGuidance(note, { sendId: "edited" });
        const edited = await heard(note);
        assert.equal(edited.text, `Edited. ${note}`, "the CLI received the edited text");
        assert.equal(edited.turnId, (await heard(toolTurn[agent])).turnId);
        assert.equal(edited.sendId, undefined);
        assert.equal(edited.promptProvenance, undefined);
      } finally {
        await cleanup(session);
      }
    },
  );
}
