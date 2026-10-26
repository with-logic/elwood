/**
 * A fake-PTY Codex session that ends a turn through its `Stop` hook, for the tests of
 * the shutdown wait on that turn's record (PRD §5.7, C-LIFE-13).
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { vi } from "vitest";
import { turnCommitWaitMs } from "../../src/codex/session/turn-commit.ts";
import { CodexTranscriptWatcher } from "../../src/codex/transcript/index.ts";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { PtyExitLatch } from "../../src/pty/exit-latch.ts";
import { launchArtifactPaths } from "../helpers/launch-artifacts.ts";
import { becomeReady, ptys, readBridgeScript } from "./helpers.ts";

const started: CodexSessionApi[] = [];
const shutdowns: Promise<unknown>[] = [];

/** Records a shutdown a test started, so `endStarted` can settle it if the test fails first. */
export function tracked(shutdown: Promise<void>): Promise<void> {
  shutdowns.push(shutdown);
  return shutdown;
}

/**
 * Kills every session the test started and settles the shutdowns it started, so a test
 * that fails early leaves no bridge server or poll timer behind. Run before resetting fakes.
 */
export async function endStarted(): Promise<void> {
  await Promise.allSettled(started.splice(0).map((session) => session.kill()));
  await Promise.allSettled(shutdowns.splice(0));
}

/** Appends one rollout record whose payload is `payloadType` for `turnId`. */
export function appendRecord(path: string, payloadType: string, turnId: string): void {
  const payload = { type: payloadType, turn_id: turnId };
  appendFileSync(path, `${JSON.stringify({ type: "event_msg", payload })}\n`);
}

/** A session mid-turn whose rollout Codex has not finished writing. */
export async function runningTurn(
  cwd: string,
  hooks: Parameters<typeof startCodex>[0]["hooks"] = {},
): Promise<{ readonly session: CodexSessionApi; readonly path: string }> {
  const path = join(cwd, "rollout.jsonl");
  writeFileSync(path, "");
  const session = await startCodex({ cwd, hooks });
  started.push(session);
  await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
  ptys[0]!.emitData("\u001b[2J\u001b[H• Working (3s • esc to interrupt)\r\n› ");
  await vi.waitFor(() => {
    if (session.status !== "running") throw new Error(`status ${session.status}`);
  });
  return { session, path };
}

/** The `Stop` hook Codex runs when turn-1 ends, before it records the turn's completion. */
function stopInput(cwd: string, transcriptPath: string | null) {
  return {
    hook_event_name: "Stop",
    session_id: "codex-1",
    cwd,
    model: "gpt-5.3-codex",
    turn_id: "turn-1",
    stop_hook_active: false,
    transcript_path: transcriptPath,
  };
}

/** Sends turn-1's `Stop` hook and resolves with the bridge's reply. */
export function stopHook(
  session: CodexSessionApi,
  cwd: string,
  transcriptPath: string | null,
): Promise<unknown> {
  return ptys[0]!.dispatchHook(session.elwoodSessionId, stopInput(cwd, transcriptPath));
}

/**
 * Sends turn-1's `Stop` hook and resolves once the bridge closes the connection, reply or
 * not: a shutdown the hook's result releases can close the bridge before it replies.
 */
export function stopHookUntilClosed(
  session: CodexSessionApi,
  cwd: string,
  transcriptPath: string,
): Promise<void> {
  const elwoodSessionId = session.elwoodSessionId;
  const dir = join(cwd, ".elwood", "sessions", elwoodSessionId);
  const { socketPath, token } = readBridgeScript(launchArtifactPaths(ptys[0]!.options, dir).bridge);
  const input = JSON.stringify(stopInput(cwd, transcriptPath));
  return new Promise((resolve) => {
    const client = createConnection({ path: socketPath });
    client.resume(); // Read the reply, if any, so the connection can end.
    client.on("close", () => resolve());
    client.on("error", () => undefined);
    client.on("connect", () =>
      client.write(`${JSON.stringify({ token, elwoodSessionId, input })}\n`),
    );
  });
}

/**
 * Ends turn-1 through its `Stop` hook and runs `verb` synchronously from the `ready` it
 * produces, as a host that closes a finished session does. Wrapped, so awaiting this
 * does not also await the shutdown.
 */
export async function shutdownAtReady(
  session: CodexSessionApi,
  cwd: string,
  verb: "stop" | "teardown",
  path: string,
): Promise<{ readonly shutdown: Promise<void> }> {
  let shutdown: Promise<void> | undefined;
  session.on("status", (event) => {
    if (event.status === "ready") shutdown ??= tracked(session[verb]());
  });
  await stopHook(session, cwd, path);
  if (!shutdown) throw new Error("the Stop hook did not report ready");
  return { shutdown };
}

/**
 * Replaces the turn-commit wait's 2-second bound with `commitWaitMs`; the other exit
 * waits on the same latch, such as termination's, keep their own bounds.
 */
function boundCommitWait(commitWaitMs: number): void {
  const within = PtyExitLatch.prototype.within;
  vi.spyOn(PtyExitLatch.prototype, "within").mockImplementation(function (
    this: PtyExitLatch,
    timeoutMs,
    options,
  ) {
    return within.call(this, timeoutMs === turnCommitWaitMs ? commitWaitMs : timeoutMs, options);
  });
}

/** Lifts the commit wait past any test's timeout: only the turn's record or the CLI's exit ends it. */
export function unboundedCommitWait(): void {
  boundCommitWait(3_600_000);
}

/** Makes every commit wait run out at once. */
export function expiringCommitWait(): void {
  boundCommitWait(0);
}

/**
 * Resolves once the transcript has been re-read `count` more times, so every record
 * appended before the call has been observed. Watcher reads are synchronous.
 */
export async function transcriptReads(count: number): Promise<void> {
  const poll = vi.spyOn(CodexTranscriptWatcher.prototype, "poll");
  const before = poll.mock.calls.length;
  await vi.waitFor(() => {
    if (poll.mock.calls.length < before + count) throw new Error("transcript not re-read yet");
  });
}
