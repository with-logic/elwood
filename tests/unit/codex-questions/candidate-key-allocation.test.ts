/** Expanded native keys respect the existing retained-byte ceiling before mapping (PRD §4). */
import { afterEach, assert, expect, test, vi } from "vitest";
import { candidateGroups } from "../../../src/codex/questions/candidate.ts";
import {
  QuestionLimitError,
  questionMetadataLimitBytes,
} from "../../../src/codex/questions/limits.ts";
import * as nativeRecords from "../../../src/codex/questions/records.ts";
import { event, setup } from "./candidate-helpers.ts";

afterEach(() => vi.restoreAllMocks());

test("preflights a long ID before expanding it into hundreds of queued keys", () => {
  const payload = {
    type: "AgentMessage",
    id: "x".repeat(questionMetadataLimitBytes - 8192),
    delivery: "async",
    questions: Array.from({ length: 256 }, () => ({ title: "Q" })),
  };
  const call = nativeRecords.questionCall(payload);
  assert.isDefined(call, "The native record itself must fit the existing metadata limit");
  const originalQueuedKey = nativeRecords.queuedKey;
  let keysGenerated = 0;
  const key = vi.spyOn(nativeRecords, "queuedKey").mockImplementation((callId, index) => {
    // Bound the regression itself if mapping is moved before preflight.
    if (++keysGenerated > 2) throw new Error("Queued keys expanded before budget preflight");
    return originalQueuedKey(callId, index);
  });
  expect(() => candidateGroups(call)).toThrow(QuestionLimitError);
  expect(key).toHaveBeenCalledOnce();
  key.mockClear();
  keysGenerated = 0;
  const { state, disabled } = setup();
  expect(state.observe(event(payload))).toBe(true);
  expect(key).toHaveBeenCalledOnce();
  expect(state.candidates.size).toBe(0);
  expect(state.hasReservation()).toBe(true);
  expect(disabled).toHaveBeenCalledOnce();
});
