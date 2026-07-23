/**
 * Coverage for observeTranscript's path following (C-CLAUDE-15, PRD §5.4): both the
 * main and agent transcript paths are observed, backward tail recovery runs only on
 * a turn-boundary first-observe, and a SubagentStop's agent transcript is retired.
 * The warning-routing/sink wiring lives in a sibling file.
 */

import { describe, expect, test } from "vitest";
import {
  type ObservableTranscript,
  observeTranscript,
} from "../../src/claude/session-transcript.ts";

describe("C-CLAUDE-15 observeTranscript path following", () => {
  test("observeTranscript follows BOTH transcript_path and agent_transcript_path", () => {
    const observed: [string, boolean][] = [];
    const watcher: ObservableTranscript = {
      observe: (p, recover) => observed.push([p, recover ?? false]),
      retire: () => {},
    };
    // A Stop is a turn boundary, so a first observe recovers the committed tail.
    observeTranscript(watcher, {
      hook_event_name: "Stop",
      transcript_path: "/main.jsonl",
      agent_transcript_path: "/sub.jsonl",
    });
    observeTranscript(watcher, {}); // neither present: ignored
    observeTranscript(watcher, { transcript_path: "" }); // empty: ignored
    expect(observed).toEqual([
      ["/main.jsonl", true],
      ["/sub.jsonl", true],
    ]);
  });

  test("observeTranscript does NOT recover history on a non-boundary hook", () => {
    const observed: [string, boolean][] = [];
    const watcher: ObservableTranscript = {
      observe: (p, recover) => observed.push([p, recover ?? false]),
      retire: () => {},
    };
    // A SessionStart/resume observe baselines at EOF: no backward recovery, so a
    // resumed session never republishes the prior conversation's final turn.
    observeTranscript(watcher, {
      hook_event_name: "SessionStart",
      transcript_path: "/main.jsonl",
    });
    expect(observed).toEqual([["/main.jsonl", false]]);
  });

  test("SubagentStop observes then RETIRES the agent transcript from active polling", () => {
    const observed: string[] = [];
    const retired: string[] = [];
    const watcher: ObservableTranscript = {
      observe: (p) => observed.push(p),
      retire: (p) => retired.push(p),
    };
    observeTranscript(watcher, {
      hook_event_name: "SubagentStop",
      transcript_path: "/main.jsonl",
      agent_transcript_path: "/sub.jsonl",
    });
    // Both observed; only the one-shot agent transcript is retired.
    expect(observed).toEqual(["/main.jsonl", "/sub.jsonl"]);
    expect(retired).toEqual(["/sub.jsonl"]);
  });
});
