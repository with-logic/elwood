/** Hook-scoped observer failures preserve subsequent telemetry (C-HOOK-22). */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-HOOK-22 throwing status observer preserves derived ready activity", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd });
  await session.sendPrompt("busy");
  const states: unknown[] = [];
  session.on("status", () => {
    throw new Error("listener");
  });
  session.on("activity", (event) => {
    if (event.kind === "status") states.push(event.status);
  });
  await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "Stop",
    session_id: "claude-1",
    cwd,
  });
  expect(states).toEqual(["ready"]);
});

test("C-HOOK-22 throwing transcript observer preserves every committed record", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd });
  const path = join(cwd, "transcript.jsonl");
  writeFileSync(path, "");
  const stop = { hook_event_name: "Stop", session_id: "claude-1", cwd, transcript_path: path };
  await ptys[0]!.dispatchHook(session.elwoodSessionId, stop);
  const delivered: unknown[] = [];
  const warnings: string[] = [];
  session.on("warning", (event) => warnings.push(event.code));
  session.on("activity", (event) => {
    if (event.kind === "assistant_message") throw new Error("listener");
  });
  session.on("activity", (event) => {
    if (event.kind === "assistant_message") delivered.push(event.text);
  });
  writeFileSync(
    path,
    `${["first", "second"]
      .map((text) =>
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text }] },
        }),
      )
      .join("\n")}\n`,
  );
  await ptys[0]!.dispatchHook(session.elwoodSessionId, stop);
  expect(delivered).toEqual(["first", "second"]);
  expect(warnings).toEqual(["hook_observer_failed"]);
});
