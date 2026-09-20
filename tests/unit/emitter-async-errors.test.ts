/** Late observer failures retain the notification scope that invoked them (C-HOOK-22). */
import { expect, test, vi } from "vitest";
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

test.each([
  "shared",
  "distinct",
] as const)("C-HOOK-22 pending %s promises retain only the newest 1024 diagnostic registrations", async (mode) => {
  const emitter = new TypedEmitter<{ event: number }>();
  const shared = Promise.withResolvers<void>();
  const sharedThen = vi.spyOn(shared.promise, "then");
  const pending = Array.from({ length: 1025 }, () =>
    mode === "shared" ? shared : Promise.withResolvers<void>(),
  );
  const errors: number[] = [];
  emitter.on("event", (index) => pending[index]!.promise);
  for (let index = 0; index < pending.length; index += 1) {
    emitter.observeErrors(
      () => {
        errors.push(index);
      },
      () => emitter.emit("event", index),
    );
  }
  expect(sharedThen).toHaveBeenCalledTimes(mode === "shared" ? 1 : 0);
  for (const item of pending) item.reject("observer failed");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(errors).toEqual(Array.from({ length: 1024 }, (_, index) => index + 1));
});

test("C-HOOK-22 a settled reused promise receives a fresh diagnostic registration", async () => {
  const emitter = new TypedEmitter<{ event: number }>();
  const promise = Promise.reject("failure");
  emitter.on("event", () => promise);
  const errors: unknown[] = [];
  for (let index = 0; index < 2; index += 1) {
    emitter.observeErrors(
      (error) => errors.push(error),
      () => emitter.emit("event", index),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(errors).toEqual(["failure", "failure"]);
});

test("C-HOOK-22 settled registrations release capacity for a still-pending observer", async () => {
  const emitter = new TypedEmitter<{ event: number }>();
  const pending = Promise.withResolvers<void>();
  const errors: unknown[] = [];
  emitter.on("event", (index) => (index === 0 ? pending.promise : Promise.resolve()));
  for (let index = 0; index <= 1024; index += 1) {
    emitter.observeErrors(
      (error) => errors.push(error),
      () => emitter.emit("event", index),
    );
    await Promise.resolve();
  }
  pending.reject("still observed");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(errors).toEqual(["still observed"]);
});
