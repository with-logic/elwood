/** Late observer failures retain the notification scope that invoked them (C-HOOK-22). */
import { expect, test } from "vitest";
import { TypedEmitter } from "../../src/events/emitter.ts";

test("C-HOOK-22 nested notification scopes retain distinct rejection sinks", async () => {
  const emitter = new TypedEmitter<{ event: number }>();
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const unscoped = Promise.withResolvers<void>();
  void unscoped.promise.catch(() => {});
  emitter.on("event", (number) => {
    if (number === 1) return first.promise;
    if (number === 2) return second.promise;
    return unscoped.promise;
  });
  const inner: unknown[] = [];
  const outer: unknown[] = [];
  expect(() =>
    emitter.observeErrors(
      (error) => outer.push(error),
      () => {
        emitter.observeErrors(
          (error) => inner.push(error),
          () => emitter.emit("event", 1),
        );
        emitter.emit("event", 2);
        throw new Error("scope unwinds");
      },
    ),
  ).toThrow("scope unwinds");
  emitter.emit("event", 3);
  first.reject("inner failure");
  second.reject("outer failure");
  unscoped.reject("outside scope");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(inner).toEqual(["inner failure"]);
  expect(outer).toEqual(["outer failure"]);
});
