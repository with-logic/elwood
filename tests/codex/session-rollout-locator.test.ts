/** Preserve optional Codex rollout locators beside independent session state (C-STATE-15). */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { CodexHookEventFor } from "../../src/codex/hooks/index.ts";
import { type ElwoodWarningEvent, resumeCodex, startCodex } from "../../src/index.ts";
import { defaultStateDir, sessionDir } from "../../src/state/store.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const nativeSessionId = "codex-native-1";

test("C-STATE-15 only the current authenticated conversation updates its private locator", async () => {
  installFakes();
  const cwd = tempDir();
  const original = await startCodex({ cwd });
  const { elwoodSessionId } = original;
  let successor: typeof original | undefined;
  const rollout = join(cwd, "original.jsonl");
  const stored = join(sessionDir(defaultStateDir(cwd), elwoodSessionId), "codex-rollout.json");
  const submit = ({
    index,
    nativeSessionId,
    transcriptPath,
  }: {
    readonly index: number;
    readonly nativeSessionId: string;
    readonly transcriptPath: string;
  }) =>
    ptys[index]!.dispatchHook(elwoodSessionId, {
      hook_event_name: "SessionStart",
      source: index === 0 ? "startup" : "resume",
      session_id: nativeSessionId,
      transcript_path: transcriptPath,
      cwd,
    } satisfies CodexHookEventFor<"SessionStart">);
  const read = () => JSON.parse(readFileSync(stored, "utf8"));
  try {
    expect(await submit({ index: 0, nativeSessionId: "", transcriptPath: rollout })).toMatchObject({
      exitCode: 0,
    });
    expect(existsSync(stored)).toBe(false);
    await submit({ index: 0, nativeSessionId, transcriptPath: rollout });
    expect(read()).toEqual({ nativeSessionId, path: rollout });
    expect(statSync(stored).mode & 0o777).toBe(0o600);
    await submit({
      index: 0,
      nativeSessionId: "other",
      transcriptPath: join(cwd, "unrelated.jsonl"),
    });
    expect(read()).toEqual({ nativeSessionId, path: rollout });

    successor = await resumeCodex({ cwd, elwoodSessionId });
    expect(read()).toEqual({ nativeSessionId, path: rollout });
    const relocated = join(cwd, "relocated.jsonl");
    await submit({ index: 1, nativeSessionId, transcriptPath: relocated });
    expect(read()).toEqual({ nativeSessionId, path: relocated });
    expect(
      await submit({ index: 0, nativeSessionId, transcriptPath: join(cwd, "superseded.jsonl") }),
    ).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(read()).toEqual({ nativeSessionId, path: relocated });
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
  const warnings: ElwoodWarningEvent[] = [];
  session.on("warning", (warning) => warnings.push(warning));
  session.on("warning", () => {
    throw new Error("warning observer fixture");
  });
  // A directory at the destination makes the atomic temp-file rename fail.
  mkdirSync(join(sessionDir(defaultStateDir(cwd), elwoodSessionId), "codex-rollout.json"));
  try {
    const reply = await ptys[0]!.dispatchHook(elwoodSessionId, {
      hook_event_name: "SessionStart",
      source: "startup",
      cwd,
      session_id: nativeSessionId,
      transcript_path: join(cwd, "transcript.jsonl"),
    } satisfies CodexHookEventFor<"SessionStart">);
    expect(reply).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(events).toEqual([nativeSessionId]);
    expect(warnings).toEqual([
      {
        elwoodSessionId,
        agent: "codex",
        source: "lifecycle",
        code: "codex_rollout_locator_write_failed",
        severity: "warning",
        message: "Elwood could not save the Codex transcript locator.",
        raw: "codex_rollout_locator_write_failed",
      },
    ]);
    expect(session.status).toBe("ready");
  } finally {
    await session.teardown();
  }
});
