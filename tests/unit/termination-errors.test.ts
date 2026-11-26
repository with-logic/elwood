/**
 * Termination error wrapping reads sweep group ids only from a sweep failure, whose
 * `processGroupIds` is an array (PRD §10, C-ERR-01, C-LIFE-10).
 */
import { expect, test } from "vitest";
import {
  thrownTerminationFailure,
  unconfirmedGroupsDetail,
} from "../../src/runtime/shutdown/termination-errors.ts";
import { sweepFailure } from "../helpers/termination-harness.ts";

const malformed = () => Object.assign(new Error("kill exploded"), { processGroupIds: "7001" });

test("C-LIFE-10 a processGroupIds that is not an array names no unconfirmed groups", () => {
  expect(unconfirmedGroupsDetail(malformed())).toEqual({});
});

test("C-ERR-01 a thrown error with a non-array processGroupIds is a PTY operation failure", () => {
  const failure = thrownTerminationFailure(malformed());
  expect(failure).toMatchObject({
    code: "termination_failed",
    message: "Could not terminate the PTY: kill exploded",
    details: { cause: "kill exploded" },
  });
  expect(failure.details).not.toHaveProperty("unconfirmedProcessGroupIds");
});

test("C-ERR-01 a thrown sweep failure keeps its groups", () => {
  const failure = thrownTerminationFailure(sweepFailure("process table unreadable", [7001]));
  expect(failure).toMatchObject({
    message: "PTY exited but its process-tree groups could not be confirmed reaped.",
    details: { unconfirmedProcessGroupIds: [7001] },
  });
});
