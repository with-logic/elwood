/**
 * Replaces only expensive adapter launches for compiled-process CLI tests (C-CLI-27).
 * Argument parsing, request preparation, turn handling, output, and private state use
 * the built artifact. The ordinary entrypoint still receives the real process argv.
 */
import { rmSync } from "node:fs";
import { defaultCliLaunchDependencies } from "../../../dist/cli/session/launch.js";
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
  session.script = (emitter) => {
    const text = `${agent} ${resumed ? "resumed" : "new"} answer`;
    emitter.emit("status", { elwoodSessionId: id, status: "running" });
    emitter.emit("activity", {
      elwoodSessionId: id,
      agent,
      source: "transcript",
      kind: "assistant_message",
      label: "assistant",
      text,
    });
    emitter.emit("hook", { hook_event_name: "Stop", last_assistant_message: text });
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
