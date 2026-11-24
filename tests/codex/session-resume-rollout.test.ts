/** Observe forward Codex transcript activity before a resumed CLI reports its path (C-STATE-15). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type CodexHookEventFor, resumeCodex, startCodex } from "../../src/index.ts";
import { currentPtyFactory, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { setStartupWaitMsForTests } from "../../src/runtime/startup/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const nativeSessionId = "native-session";

function line(item: unknown): string {
  return `${JSON.stringify(item)}\n`;
}

function message(text: string) {
  return {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text }],
    },
  };
}

async function saveRollout() {
  installFakes();
  const cwd = tempDir();
  const rollout = join(cwd, "rollout.jsonl");
  writeFileSync(rollout, line({ type: "session_meta", payload: { id: nativeSessionId } }));
  const initial = await startCodex({ cwd });
  try {
    await becomeReady(initial.elwoodSessionId, cwd, {
      session_id: nativeSessionId,
      transcript_path: rollout,
    });
    appendFileSync(rollout, line(message("previous launch")));
  } finally {
    await initial.stop();
  }
  return { cwd, rollout, elwoodSessionId: initial.elwoodSessionId };
}

test("C-STATE-15 delivers immediate resumed appends with no path-bearing hook or history", async () => {
  const { rollout, ...resume } = await saveRollout();
  const appended = message("appended at PTY spawn");
  const factory = currentPtyFactory();
  setPtyFactoryForTests((options) => {
    appendFileSync(rollout, line(appended));
    return factory(options);
  });
  // A polling interval started at spawn would consume this entry before callers can subscribe.
  setStartupWaitMsForTests(350);
  const session = await resumeCodex(resume);
  const seen: unknown[] = [];
  const activities: unknown[] = [];
  session.on("codex:transcript", ({ item }) => seen.push(item));
  session.on("activity", (event) => {
    if (event.source === "transcript") activities.push(event);
  });
  try {
    await expect.poll(() => seen, { timeout: 3_000 }).toEqual([appended]);
    expect(activities).toEqual([
      expect.objectContaining({ kind: "assistant_message", text: "appended at PTY spawn" }),
    ]);
  } finally {
    await session.teardown();
  }
});

test("C-STATE-15 an unusable locator falls back to authenticated hook discovery", async () => {
  const { rollout, ...resume } = await saveRollout();
  const { cwd, elwoodSessionId } = resume;
  const locator = join(cwd, ".elwood", "sessions", elwoodSessionId, "codex-rollout.json");
  writeFileSync(locator, line({ path: rollout, nativeSessionId: "unrelated-conversation" }));
  const session = await resumeCodex(resume);
  const seen: unknown[] = [];
  session.on("codex:transcript", ({ item }) => seen.push(item));
  try {
    appendFileSync(rollout, line(message("before a path-bearing hook")));
    await ptys[1]!.dispatchHook(elwoodSessionId, {
      hook_event_name: "SessionStart",
      session_id: nativeSessionId,
      transcript_path: rollout,
      cwd,
      source: "startup",
    } satisfies CodexHookEventFor<"SessionStart">);
    const appended = message("after a path-bearing hook");
    appendFileSync(rollout, line(appended));
    await expect.poll(() => seen, { timeout: 3_000 }).toEqual([appended]);
  } finally {
    await session.teardown();
  }
});
