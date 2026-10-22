/** Native queue routes contain one question per acceptance unit (PRD §4). */
import { expectTypeOf, test } from "vitest";
import type { QueuedCandidate } from "../../../src/codex/questions/candidate.ts";
import type { QueuedNativeQuestion } from "../../../src/codex/questions/definitions.ts";

test("queued candidates encode exactly one native question", () => {
  expectTypeOf<QueuedCandidate["questions"]>().toEqualTypeOf<readonly [QueuedNativeQuestion]>();
  expectTypeOf<readonly []>().not.toExtend<QueuedCandidate["questions"]>();
  expectTypeOf<readonly [QueuedNativeQuestion, QueuedNativeQuestion]>().not.toExtend<
    QueuedCandidate["questions"]
  >();
});
