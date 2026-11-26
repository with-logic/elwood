/**
 * Real Claude readiness across the turn that runs queued guidance (PRD §6.5, C-HOOK-24). Claude
 * queues guidance sent during a turn without tools and, at that turn's `Stop`, runs it at once
 * as a new turn with its own `Stop`. The session must stay `running` until that second `Stop`,
 * including while a caller's handler still screens the guidance past the first. Guidance the
 * handler blocks never runs, so the first `Stop` marks the session ready.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  type ClaudeHookEventFor,
  type ClaudeHookResultForEvent,
  type ClaudeSessionApi,
  type ElwoodWarningEvent,
  startClaude,
} from "../../src/index.ts";
import { cleanup, makeProject, skipIf, skipReason, skipTurns, waitFor } from "./helpers.ts";

const options = { skip: skipIf(skipReason("claude"), skipTurns), timeout: 280_000 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Screen = (
  event: ClaudeHookEventFor<"UserPromptSubmit">,
) => Promise<ClaudeHookResultForEvent<ClaudeHookEventFor<"UserPromptSubmit">> | undefined>;

type Seen = {
  stops: number;
  readonly readyAfterStops: number[];
  readonly guidanceAfterStops: number[];
  readonly warnings: ElwoodWarningEvent["code"][];
  readonly firstStop: Promise<void>;
};

/** A session writing a tool-free essay, with guidance queued behind it once Claude runs it. */
async function essayWithGuidance(
  screen?: (seen: Seen) => Screen,
): Promise<{ session: ClaudeSessionApi; seen: Seen }> {
  const project = makeProject("claude");
  const isGuidance = (prompt: string) => prompt.includes("Coordinator note");
  let stopped = () => {};
  const seen: Seen = {
    stops: 0,
    readyAfterStops: [],
    guidanceAfterStops: [],
    warnings: [],
    firstStop: new Promise<void>((resolve) => {
      stopped = resolve;
    }),
  };
  const handler = screen?.(seen);
  const session = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    permissionMode: "bypassPermissions",
    autotrust: true,
    // A handler that answers after the essay's Stop must outlast a slow essay.
    hookTimeoutMs: 150_000,
    hooks: {
      UserPromptSubmit: (event) =>
        handler && isGuidance(event.prompt) ? handler(event) : undefined,
    },
  });
  let promptHeard = false;
  try {
    session.on("hook", (event) => {
      if (event.hook_event_name === "UserPromptSubmit") {
        if (isGuidance(event.prompt)) seen.guidanceAfterStops.push(seen.stops);
        else promptHeard = true;
      }
      if (event.hook_event_name !== "Stop") return;
      seen.stops += 1;
      stopped();
    });
    session.on("warning", (warning) => void seen.warnings.push(warning.code));
    await waitFor(() => (session.status === "ready" ? true : undefined), "initial ready", 60_000);
    session.on("status", (event) => {
      if (event.status === "ready") seen.readyAfterStops.push(seen.stops);
    });
    await session.sendMessage(
      "Write a detailed 400-word essay about the history of terminals. Do not use tools.",
    );
    // Claude is running the essay once its own prompt fires UserPromptSubmit.
    await waitFor(() => (promptHeard ? true : undefined), "essay prompt hook", 60_000);
    await sleep(1_000);
    await session.sendGuidance(
      "Coordinator note: after the essay, write a 200-word poem about keyboards. Do not use tools.",
    );
    return { session, seen };
  } catch (error) {
    await cleanup(session);
    throw error;
  }
}

async function finalReady(session: ClaudeSessionApi, seen: Seen, stops: number): Promise<void> {
  const ready = () => (seen.stops >= stops && session.status === "ready" ? true : undefined);
  await waitFor(ready, `ready after ${stops} Stop(s)`, 200_000);
  // A late, wrong `ready` or queued turn would land here.
  await sleep(3_000);
}

test(
  "C-HOOK-24 real Claude stays running through the turn that runs queued guidance",
  options,
  async () => {
    const { session, seen } = await essayWithGuidance();
    try {
      await finalReady(session, seen, 2);
      assert.deepEqual(seen.guidanceAfterStops, [0], "the note queued behind the essay");
      assert.equal(seen.stops, 2, "the essay and the queued turn each stop");
      assert.deepEqual(seen.readyAfterStops, [2], "ready only after the queued turn's Stop");
      assert.deepEqual(seen.warnings, []);
    } finally {
      await cleanup(session);
    }
  },
);

test("C-HOOK-24 real Claude blocked guidance holds no Stop", options, async () => {
  const block: Screen = async () => ({ decision: "block", reason: "Not now." });
  const { session, seen } = await essayWithGuidance(() => block);
  try {
    await finalReady(session, seen, 1);
    assert.deepEqual(seen.guidanceAfterStops, [0]);
    assert.equal(seen.stops, 1, "Claude never runs blocked guidance");
    assert.deepEqual(seen.readyAfterStops, [1]);
    assert.deepEqual(seen.warnings, []);
  } finally {
    await cleanup(session);
  }
});

test(
  "C-HOOK-24 real Claude stays running while a handler screens guidance past the Stop",
  options,
  async () => {
    const screened: number[] = [];
    const allowLate =
      (seen: Seen): Screen =>
      async () => {
        await seen.firstStop;
        await sleep(3_500);
        screened.push(seen.stops);
        return undefined;
      };
    const { session, seen } = await essayWithGuidance(allowLate);
    try {
      await finalReady(session, seen, 2);
      assert.deepEqual(screened, [1], "the handler answered after the essay's Stop");
      assert.equal(seen.stops, 2);
      assert.deepEqual(seen.readyAfterStops, [2], "no ready while the handler screened");
      assert.deepEqual(seen.warnings, []);
    } finally {
      await cleanup(session);
    }
  },
);
