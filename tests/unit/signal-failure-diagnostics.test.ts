/** Signal aggregates preserve native diagnostics through termination (PRD §10, C-ERR-01). */
import { expect, test } from "vitest";
import { aggregateSignalFailures } from "../../src/runtime/shutdown/merge-sweep-errors.ts";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import { harness, timeouts } from "../helpers/termination-harness.ts";

test("C-ERR-01 combined signal failures retain the first OS operation through termination", async () => {
  const first = new Error("hold failed");
  const native = Object.assign(new Error("read failed"), {
    code: "EIO",
    syscall: "spawn",
    path: "/bin/ps",
  });
  const later = Object.assign(new Error("restore failed"), {
    code: "EPERM",
    syscall: "kill",
    path: "/other",
  });
  const failure = aggregateSignalFailures([first, native, later]);
  expect(failure.errors).toEqual([first, native, later]);
  const { pty, reaper } = harness({ killError: failure });
  await expect(terminatePty(pty, "SIGTERM", reaper, timeouts)).rejects.toMatchObject({
    code: "termination_failed",
    details: {
      cause: "hold failed; read failed; restore failed",
      errno: "EIO",
      syscall: "spawn",
      path: "/bin/ps",
    },
  });
});

test("C-ERR-01 native fields without an errno are retained only when strings", () => {
  const failure = aggregateSignalFailures([
    Object.assign(new Error("failed"), { syscall: "kill", path: "/bin/ps" }),
    "secondary",
  ]);
  expect(failure).toMatchObject({ syscall: "kill", path: "/bin/ps" });
  expect(failure).not.toHaveProperty("code");
  const malformed = aggregateSignalFailures([
    Object.assign(new Error("failed"), { code: "EIO", syscall: 1, path: {} }),
  ]);
  expect(malformed).not.toHaveProperty("syscall");
  expect(malformed).not.toHaveProperty("path");
});

test("C-ERR-01 an empty aggregate has no invented OS details", () => {
  expect(aggregateSignalFailures([])).toMatchObject({ errors: [], message: "" });
});
