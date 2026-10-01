/** Internal Stop context follows one runtime instance, not an ID shared elsewhere (C-HOOK-04). */
import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import {
  assertStopInput,
  outsideStopInput,
  withStopInput,
  withStopInputNotification,
} from "../../src/core/stop-input.ts";

test("C-HOOK-04 same-ID sessions retain separate Stop context identity", async () => {
  const first = { elwoodSessionId: "reused" };
  const second = { elwoodSessionId: "reused" };
  const release = Promise.withResolvers<void>();
  let late: Promise<readonly [unknown, string]> | undefined;
  await withStopInput({ hookName: "Stop", session: first }, () => {
    late = (async () => {
      await release.promise;
      let expired: unknown;
      try {
        assertStopInput(first);
      } catch (error) {
        expired = error;
      }
      assertStopInput(second);
      return [expired, "allowed"] as const;
    })();
    return Promise.resolve();
  });
  release.resolve();
  const [expired, allowed] = await late!;
  expect(expired).toMatchObject({ code: "wait_timeout" });
  expect(allowed).toBe("allowed");
});

test("C-HOOK-04 independently dispatched event callbacks do not inherit registration context", async () => {
  const session = { elwoodSessionId: "events" };
  const source = new EventEmitter();
  let admitted: string | undefined;
  await withStopInput({ hookName: "Stop", session }, () => {
    source.once("input", () => {
      assertStopInput(session);
      admitted = "allowed";
    });
    return Promise.resolve();
  });
  source.emit("input");
  expect(admitted).toBe("allowed");
});

test("C-HOOK-04 repeated Stop scopes share instance identity and expire separately", async () => {
  const session = { elwoodSessionId: "repeat" };
  const release = Promise.withResolvers<void>();
  const continuations: Promise<unknown>[] = [];
  for (let index = 0; index < 2; index += 1) {
    await withStopInput({ hookName: "Stop", session }, () => {
      continuations.push(
        release.promise.then(() => {
          try {
            return assertStopInput(session);
          } catch (error) {
            return error;
          }
        }),
      );
      return Promise.resolve();
    });
  }
  release.resolve();
  for (const continuation of continuations)
    expect(await continuation).toMatchObject({ code: "wait_timeout" });
});

test("C-HOOK-04 explicit internal detachment leaves the caller context intact", async () => {
  const session = { elwoodSessionId: "detachment" };
  const release = Promise.withResolvers<void>();
  let late: Promise<void> | undefined;
  await withStopInput({ hookName: "Stop", session }, () => {
    assertStopInput(session);
    late = release.promise.then(() => {
      outsideStopInput(() => assertStopInput(session));
      expect(() => assertStopInput(session)).toThrow("already completed");
    });
    return Promise.resolve();
  });
  release.resolve();
  await late;
});

test("C-HOOK-04 synchronous diagnostic contexts close even when a sink throws", async () => {
  const session = { elwoodSessionId: "diagnostic" };
  let late: Promise<void> | undefined;
  expect(() =>
    withStopInputNotification({ hookName: "Stop", session }, () => {
      assertStopInput(session);
      late = Promise.resolve().then(() => {
        expect(() => assertStopInput(session)).toThrow("already completed");
      });
      throw new Error("sink failure");
    }),
  ).toThrow("sink failure");
  await late;
});
