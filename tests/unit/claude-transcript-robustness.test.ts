/**
 * Robustness of the Claude transcript watcher: contained fs errors, surfaced
 * programming errors, and bounded drop diagnostics. Covers PRD §5.4 (C-CLAUDE-15).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  resetByteReaderForTests,
  setByteReaderForTests,
} from "../../src/claude/transcript/cursor.ts";
import {
  type TranscriptReadErrorNotice as DropsReadErrorNotice,
  ReadErrorReporter,
} from "../../src/claude/transcript/drops.ts";
import {
  type ClaudeTranscriptEvent,
  ClaudeTranscriptWatcher,
  type TranscriptDropNotice,
  type TranscriptReadErrorNotice,
} from "../../src/claude/transcript/index.ts";
import { assistant, eisdirError, tmpFile } from "./claude-transcript-helpers.ts";

afterEach(resetByteReaderForTests);

const record = (r: unknown) => `${JSON.stringify(r)}\n`;

describe("C-CLAUDE-15 transcript watcher robustness", () => {
  test("skips malformed JSON and reports a bounded drop diagnostic (no raw content)", () => {
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const drops: TranscriptDropNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e), {
      onDrop: (d) => drops.push(d),
    });
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, `${record(assistant("ok"))}{ not json }\n`);
    watcher.finish();
    expect(
      events.map((e) => (e.summary.kind === "assistant_message" ? e.summary.text : "")),
    ).toEqual(["ok"]);
    // Bounded, content-free: cause + path only, never the raw line, never a count.
    expect(drops).toEqual([{ elwoodSessionId: "s1", path, cause: "unparseable" }]);
  });

  test("a filesystem error during scan is contained AND surfaced as a bounded diagnostic", () => {
    // The path became a directory mid-session (a rotation-race-like error): the
    // read throws EISDIR, which the fs guard must swallow without crashing the
    // timer, while still surfacing a bounded, content-free read-error notice
    // (path + error code, never a count). The reader seam injects the throw so the
    // test does not depend on the host's directory stat size.
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const readErrors: TranscriptReadErrorNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e), {
      onReadError: (n) => readErrors.push(n),
    });
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, record(assistant("pending"))); // the cursor has work to read
    setByteReaderForTests(() => {
      throw eisdirError();
    });
    expect(() => watcher.scan()).not.toThrow();
    expect(events).toEqual([]);
    watcher.finish();
    // Not silent: a bounded notice carrying the last error code and path (never a count).
    expect(readErrors.at(-1)).toMatchObject({ elwoodSessionId: "s1", path });
    expect(readErrors.at(-1)!.lastErrorCode).toBe("EISDIR");
  });

  test("a failing baseline read at observe is contained (no crash, no baseline)", () => {
    // Every byte read fails (a rotation race at first observe), so the baseline
    // read throws; observe must contain it and emit nothing rather than propagate.
    // recoverTail=true so the baseline path (not just cursor construction) runs.
    const path = tmpFile();
    writeFileSync(path, `${JSON.stringify(assistant("tail"))}\n`);
    setByteReaderForTests(() => {
      throw eisdirError();
    });
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    expect(() => watcher.observe(path, true)).not.toThrow();
    expect(events).toEqual([]);
    watcher.stop();
  });

  test("a failing cursor construction at observe is contained (no cursor registered)", () => {
    // The path's parent is a regular file, so constructing the cursor stats an
    // ENOTDIR path and throws; observe must contain it and register no cursor, so
    // a later scan/finish stays a no-op rather than crashing.
    const file = tmpFile();
    writeFileSync(file, "x");
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    expect(() => watcher.observe(join(file, "child.jsonl"), true)).not.toThrow();
    expect(() => watcher.finish()).not.toThrow();
    expect(events).toEqual([]);
  });

  test("a downstream emit/listener error is NOT swallowed by the fs guard", () => {
    // The guard contains only the filesystem read; a programming error in an
    // activity listener must surface, not be silently masked.
    const path = tmpFile();
    const watcher = new ClaudeTranscriptWatcher("s1", () => {
      throw new Error("listener bug");
    });
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, record(assistant("boom")));
    expect(() => watcher.scan()).toThrow("listener bug");
    watcher.stop();
  });

  test("drop delivery is BOUNDED: many malformed lines in one pass coalesce to one warning", () => {
    // §9.2: 60 malformed lines in ONE scan/finish pass must not fan out 60 synchronous
    // warning emissions (a chunk can hold millions). The incident still surfaces — one
    // content-free `unparseable` drop per (path, cause) per pass — never a running count,
    // never persisted, never raw content.
    const path = tmpFile();
    const drops: TranscriptDropNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", () => {}, {
      onDrop: (d: TranscriptDropNotice) => drops.push(d),
    });
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, `${Array.from({ length: 60 }, () => "{ bad }").join("\n")}\n`);
    watcher.finish();
    expect(drops.filter((d) => d.cause === "unparseable")).toEqual([
      { elwoodSessionId: "s1", path, cause: "unparseable" },
    ]);
    // Content-free: no notice field carries any raw line text.
    expect(JSON.stringify(drops)).not.toContain("bad");
  });

  test("C-CLAUDE-15 a NON-string error code normalizes to UNKNOWN (never round-trips a number)", () => {
    // `lastErrorCode` is a string in the warning contract; a numeric `code` must
    // become "UNKNOWN" rather than round-tripping a number through the string-typed
    // field. Mirrors the Codex reporter.
    const errs: DropsReadErrorNotice[] = [];
    const reporter = new ReadErrorReporter("s", (n: DropsReadErrorNotice) => errs.push(n));
    reporter.record("/t", { code: "EISDIR" });
    reporter.record("/t", new Error("boom")); // no `.code` → UNKNOWN
    reporter.record("/t", { code: 5 }); // NUMERIC code must NOT round-trip → UNKNOWN
    expect(errs.map((e) => e.lastErrorCode)).toEqual(["EISDIR", "UNKNOWN", "UNKNOWN"]);
    const silent = new ReadErrorReporter("s", undefined);
    expect(() => silent.record("/t", {})).not.toThrow();
  });
});
