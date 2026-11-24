/** Preserve optional Codex rollout locators beside independent session state (C-STATE-15). */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { CodexHookEventFor } from "../../src/codex/hooks/index.ts";
import { resumeCodex, startCodex } from "../../src/index.ts";
import { defaultStateDir, sessionDir } from "../../src/state/store.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const nativeId = "codex-native-1";

test("C-STATE-15 only the current authenticated conversation updates its private locator", async () => {
  installFakes();
  const cwd = tempDir();
  const original = await startCodex({ cwd });
  const { elwoodSessionId } = original;
  let successor: typeof original | undefined;
  const rollout = join(cwd, "original.jsonl");
  const stored = join(sessionDir(defaultStateDir(cwd), elwoodSessionId), "codex-rollout.json");
  const submit = (index: number, session_id: string, transcript_path: string) =>
    ptys[index]!.dispatchHook(elwoodSessionId, {
      hook_event_name: "SessionStart",
      source: index === 0 ? "startup" : "resume",
      session_id,
      transcript_path,
      cwd,
    } satisfies CodexHookEventFor<"SessionStart">);
  const read = () => JSON.parse(readFileSync(stored, "utf8"));
  try {
    await submit(0, nativeId, rollout);
    expect(read()).toEqual({ nativeSessionId: nativeId, path: rollout });
    expect(statSync(stored).mode & 0o777).toBe(0o600);
    await submit(0, "other", join(cwd, "unrelated.jsonl"));
    expect(read()).toEqual({ nativeSessionId: nativeId, path: rollout });

    successor = await resumeCodex({ cwd, elwoodSessionId });
    expect(read()).toEqual({ nativeSessionId: nativeId, path: rollout });
    const relocated = join(cwd, "relocated.jsonl");
    await submit(1, nativeId, relocated);
    expect(read()).toEqual({ nativeSessionId: nativeId, path: relocated });
    expect(await submit(0, nativeId, join(cwd, "superseded.jsonl"))).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(read()).toEqual({ nativeSessionId: nativeId, path: relocated });
  } finally {
    await successor?.teardown();
    await original.teardown();
  }
});

test("C-STATE-15 an unavailable optional locator cannot stop SessionStart or readiness", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  const { elwoodSessionId } = session;
  const events: string[] = [];
  session.on("hook:SessionStart", ({ session_id }) => {
    events.push(session_id);
    return undefined;
  });
  session.on("warning", ({ code, raw }) => events.push(`${code}:${raw}`));
  // A directory at the destination makes the atomic temp-file rename fail.
  mkdirSync(join(sessionDir(defaultStateDir(cwd), elwoodSessionId), "codex-rollout.json"));
  try {
    const reply = await ptys[0]!.dispatchHook(elwoodSessionId, {
      hook_event_name: "SessionStart",
      source: "startup",
      cwd,
      session_id: nativeId,
      transcript_path: join(cwd, "transcript.jsonl"),
    } satisfies CodexHookEventFor<"SessionStart">);
    expect(reply).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        nativeId,
        "codex_rollout_locator_write_failed:codex_rollout_locator_write_failed",
      ]),
    );
    expect(session.status).toBe("ready");
  } finally {
    await session.teardown();
  }
});
