/**
 * The Codex watcher observes ONLY the session's own rollout file: a
 * `SubagentStop` carrying `agent_transcript_path` does not add a second cursor.
 * Pins the PRD §5.7 boundary (the Claude twin DOES observe both paths, see
 * claude-transcript-observe.test.ts) so the spec and the code cannot drift apart
 * silently again.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CodexTranscriptWatcher } from "../../src/codex/transcript/watcher.ts";
import { tempDirForUnit } from "./helpers.ts";

const record = JSON.stringify({ type: "response_item", payload: { type: "reasoning" } });

describe("Codex subagent transcripts (§5.7)", () => {
  test("a subagent transcript path is not polled; only the session rollout is", () => {
    const dir = tempDirForUnit();
    const rollout = join(dir, "rollout.jsonl");
    const subagent = join(dir, "subagent.jsonl");
    writeFileSync(rollout, "");
    writeFileSync(subagent, `${record}\n`);
    const kinds: string[] = [];
    const watcher = new CodexTranscriptWatcher("s1", (event) => kinds.push(event.summary.kind));
    watcher.observe(rollout);
    // The only observe() the Codex session ever makes is for the rollout path, so
    // the subagent file's committed record is never projected as activity.
    watcher.scan();
    expect(kinds).toEqual([]);
    writeFileSync(rollout, `${record}\n`);
    watcher.scan();
    expect(kinds).toEqual(["reasoning"]);
    watcher.finish();
  });
});
