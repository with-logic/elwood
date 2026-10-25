/**
 * The boundary-signal accessors (PRD §5.8 / §10 / §12A): a bare string is the completeness
 * signal on its own, while the object form additionally carries an adapter's evidence
 * that the agent REJECTED the turn. Emptiness is never failure evidence (§12A.3).
 */
import { expect, test } from "vitest";
import { ElwoodError } from "../../src/core/errors.ts";
import {
  boundaryExpectation,
  boundaryFailure,
  boundaryRejection,
  boundaryText,
} from "../../src/core/simple/boundary-signal.ts";

test("C-API-48 a string signal is the expected text and carries no failure", () => {
  expect(boundaryText("hello")).toBe("hello");
  expect(boundaryFailure("hello")).toBeUndefined();
  // An EMPTY string is a legitimate boundary carrying no text, NOT a failure: PRD §12A.3
  // allows an empty successful response, so emptiness must never imply rejection.
  expect(boundaryText("")).toBe("");
  expect(boundaryFailure("")).toBeUndefined();
});

test("C-API-48 an object signal carries both the text and the adapter's failure evidence", () => {
  const failure = { message: "usage limit reached", info: "usage_limit_exceeded" };
  const signal = { text: "", failure };
  expect(boundaryText(signal)).toBe("");
  expect(boundaryFailure(signal)).toBe(failure);
  // A failed turn may still carry text; the two halves are independent.
  expect(boundaryText({ text: "partial", failure })).toBe("partial");
});

test("C-API-48 an absent signal stays absent: it is not a boundary at all", () => {
  expect(boundaryExpectation(undefined)).toBeUndefined();
  expect(boundaryExpectation("done")).toBe("done");
  expect(boundaryExpectation({ text: "", failure: { message: "rejected" } })).toBe("");
});

test("C-API-59 only a failure-bearing signal becomes a turn_failed rejection", () => {
  expect(boundaryRejection(undefined)).toBeUndefined();
  expect(boundaryRejection("")).toBeUndefined(); // an empty boundary is success, not failure
  const classified = boundaryRejection({
    text: "",
    failure: { message: "Claude rejected the turn: model_not_found", info: "model_not_found" },
  });
  expect(classified).toBeInstanceOf(ElwoodError);
  expect(classified).toMatchObject({
    code: "turn_failed",
    message: "Claude rejected the turn: model_not_found",
    details: { info: "model_not_found" },
  });
  const bare = boundaryRejection({ text: "", failure: { message: "Claude rejected the turn." } });
  expect(bare).toMatchObject({ code: "turn_failed", details: {} });
  expect(bare?.details).not.toHaveProperty("info");
});
