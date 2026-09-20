/** Collected launch generations cannot retain keys or revoke successors (C-API-20). */
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test("C-API-20 finalizers remove only the collected launch's registry entry", async () => {
  // Observe the platform finalizer registration; trigger its callback explicitly
  // because the VM does not guarantee when garbage collection will run in a test.
  const pending: unknown[] = [];
  let finalize: (held: unknown) => void = () => {
    throw new Error("not registered");
  };
  const NativeRegistry = FinalizationRegistry;
  vi.stubGlobal(
    "FinalizationRegistry",
    class extends NativeRegistry<unknown> {
      constructor(callback: (held: unknown) => void) {
        super(callback);
        finalize = callback;
      }
      override register(target: WeakKey, held: unknown, token?: WeakKey): void {
        pending.push(held);
        super.register(target, held, token);
      }
    },
  );
  vi.resetModules();
  const { reserveLaunchOwnership } = await import("../../src/state/launch-ownership.ts");
  const first = reserveLaunchOwnership("/collected");
  first.commit();
  const second = reserveLaunchOwnership("/collected");
  second.commit();
  finalize(pending[0]);
  expect(first.current()).toBe(false);
  expect(second.current()).toBe(true);
  finalize(pending[1]);
  expect(second.current()).toBe(false);
  first.release();
  second.release();
});
