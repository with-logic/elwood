/**
 * Replaces only expensive adapter launches for compiled-process CLI tests (C-CLI-27).
 * Argument parsing, request preparation, turn handling, output, and private state use
 * the built artifact. The ordinary entrypoint still receives the real process argv.
 */
import { rmSync } from "node:fs";
import { defaultCliLaunchDependencies } from "../../../dist/cli/session/launch.js";
import { confirmNativeBoundary } from "../../../dist/core/simple/native-boundary.js";
import { registerNativeIdle } from "../../../dist/core/simple/native-idle.js";
import { submissionAttempt } from "../../../dist/core/simple/submission-context.js";
import {
  createSessionRecord,
  prepareStateDir,
  readSessionRecord,
  sessionDir,
  updateSessionResumeId,
  writeSessionRecord,
} from "../../../dist/state/store.js";
import { FakeUnderlying } from "../../unit/simple-fakes.ts";

function launch(agent, options, id, resumed) {
  const { cwd, stateDir } = options;
  if (resumed) {
    const record = readSessionRecord(stateDir, id);
    if (record.adapter !== agent) throw new Error("Wrong resume adapter");
  } else {
    prepareStateDir(stateDir);
    const record = createSessionRecord({ cwd, id, adapter: agent });
    writeSessionRecord(
      updateSessionResumeId(record, agent, `native-${id}`),
      sessionDir(stateDir, id),
    );
  }
  const session = Object.assign(new FakeUnderlying(), { elwoodSessionId: id, cwd });
  let rendered = 0;
  registerNativeIdle(session, {
    capture: () => {
      const before = rendered;
      return { isIdle: () => rendered > before, isReady: () => rendered > before };
    },
    subscribe: () => () => undefined,
  });
  session.script = (emitter, turnId) => {
    // Launch is the only stub: provide the private dispatch/acceptance/completion contract.
    submissionAttempt(session)?.beforeEnter(session.args["sendMessage"][0]);
    emitter.emit("hook", {
      hook_event_name: "UserPromptSubmit",
      prompt: session.args["sendMessage"][0],
      turn_id: turnId,
    });
    const text = `${agent} ${resumed ? "resumed" : "new"} answer`;
    emitter.emit("status", { elwoodSessionId: id, status: "running" });
    emitter.emit("activity", {
      elwoodSessionId: id,
      agent,
      source: "transcript",
      kind: "assistant_message",
      label: "assistant",
      text,
      turnId,
    });
    emitter.emit("hook", {
      hook_event_name: "Stop",
      turn_id: turnId,
      last_assistant_message: text,
    });
    rendered += 1;
    if (agent === "codex") confirmNativeBoundary(session, { kind: "stop", turnId, signal: text });
    emitter.emit("status", { elwoodSessionId: id, status: "ready" });
  };
  session.teardown = async () => rmSync(sessionDir(stateDir, id), { recursive: true, force: true });
  return Promise.resolve(session);
}

Object.assign(defaultCliLaunchDependencies, {
  startClaude: (options, id) => launch("claude", options, id, false),
  startCodex: (options, id) => launch("codex", options, id, false),
  resumeClaude: (options) => launch("claude", options, options.elwoodSessionId, true),
  resumeCodex: (options) => launch("codex", options, options.elwoodSessionId, true),
});
