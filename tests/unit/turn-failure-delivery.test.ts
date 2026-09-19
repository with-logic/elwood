/**
 * Delivery-path integrity for Codex turn-failure evidence (PRD §5.4/§12A.5, C-API-57).
 *
 * Turn-failure detection rides the `activity` projection, which the watcher emits AFTER the
 * public `codex:transcript` event. A throwing PUBLIC consumer must not abort that sequence:
 * doing so drops a rejected turn's only evidence and silently restores the #19 empty-success
 * bug. This is the sixth variant of that bug class and the first on the delivery path rather
 * than in classification — recognition is worth nothing if the evidence never arrives.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createCodexTranscriptWatcher } from "../../src/codex/session/transcript.ts";
import type { CodexEventMap } from "../../src/codex/session/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { tempDirForUnit } from "./helpers.ts";

const record = JSON.stringify({ type: "response_item", payload: { type: "reasoning" } });

/** A wired watcher already observing an empty temp transcript at `path`. */
function wired() {
  const emitter = new TypedEmitter<CodexEventMap>();
  const built = createCodexTranscriptWatcher("s1", emitter, () => undefined);
  const path = join(tempDirForUnit(), "rollout.jsonl");
  writeFileSync(path, "");
  built.watcher.observe(path);
  return { ...built, emitter, path };
}

describe("C-API-57 a throwing transcript consumer cannot hide rejection evidence", () => {
  test("activity is delivered even when a codex:transcript consumer THROWS", () => {
    // Turn-failure detection rides `activity`, which is emitted after the public
    // `codex:transcript`. A throwing public consumer must not abort the sequence: doing so
    // would drop a rejected turn's evidence and silently restore the #19 empty-success bug.
    // The consumer's error is still surfaced — rethrown after delivery, never swallowed.
    const seen: string[] = [];
    const { watcher, emitter, path } = wired();
    emitter.on("codex:transcript", () => {
      throw new Error("consumer bug");
    });
    emitter.on("activity", (event) => seen.push(event.kind));
    writeFileSync(path, `${record}\n`);
    expect(() => watcher.scan()).toThrow("consumer bug");
    // Asserting only the rethrow would pass even if delivery were aborted — this is the point.
    expect(seen).toEqual(["reasoning"]);
  });
});
