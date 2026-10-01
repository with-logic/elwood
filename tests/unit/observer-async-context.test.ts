/** Shared Promise diagnostics use each registration's execution context (C-HOOK-22). */
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, test } from "vitest";
import { TypedEmitter } from "../../src/events/emitter.ts";

test("C-HOOK-22 shared reactions preserve distinct observer registration contexts", async () => {
  const context = new AsyncLocalStorage<string>();
  const emitter = new TypedEmitter<{ event: number }>();
  const pending = Promise.withResolvers<void>();
  const seen: unknown[] = [];
  emitter.on("event", () => pending.promise);
  for (const name of ["first", "second"]) {
    context.run(name, () =>
      emitter.observeErrors(
        () => seen.push({ registration: name, context: context.getStore() }),
        () => emitter.emit("event", 1),
      ),
    );
  }
  pending.reject(new Error("shared failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(seen).toEqual([
    { registration: "first", context: "first" },
    { registration: "second", context: "second" },
  ]);
});
