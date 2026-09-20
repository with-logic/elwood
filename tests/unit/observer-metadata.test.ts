/** Failed native Promise attachment stays retryable (PRD §6.4, C-HOOK-22). */
import { expect, test } from "vitest";
import { TypedEmitter } from "../../src/events/emitter.ts";

test.each([
  "constructor",
  "species",
] as const)("C-HOOK-22 a throwing %s does not leave a false pending registration", async (kind) => {
  const emitter = new TypedEmitter<{ event: number }>();
  const pending = Promise.withResolvers<void>();
  const failure = new Error("invalid Promise metadata");
  const descriptor = {
    configurable: true,
    get: () => {
      throw failure;
    },
  };
  if (kind === "constructor") Object.defineProperty(pending.promise, "constructor", descriptor);
  else
    Object.defineProperty(pending.promise, "constructor", {
      configurable: true,
      value: Object.defineProperty({}, Symbol.species, descriptor),
    });
  emitter.on("event", () => pending.promise);
  let delivered = 0;
  emitter.on("event", () => {
    delivered += 1;
  });
  const errors: unknown[] = [];
  const notify = () =>
    emitter.observeErrors(
      (error) => errors.push(error),
      () => emitter.emit("event", 1),
    );
  notify();
  notify();
  expect(errors).toEqual([failure, failure]);
  expect(delivered).toBe(2);
  Reflect.deleteProperty(pending.promise, "constructor");
  notify();
  pending.reject("ordinary rejection after metadata repair");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(errors).toEqual([failure, failure, "ordinary rejection after metadata repair"]);
  expect(delivered).toBe(3);
});
