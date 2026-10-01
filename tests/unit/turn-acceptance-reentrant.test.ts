/** Reentrant completion retains the physical write already entering its adapter (C-API-48). */
import { expect, test, vi } from "vitest";
import { TurnAcceptance } from "../../src/core/simple/turn-acceptance.ts";

test.each([
  "resolve",
  "reject",
] as const)("C-API-48 synchronous boundary quiescence waits for a writer that will %s", async (outcome) => {
  const physical = Promise.withResolvers<void>();
  let quiescence: Promise<void> | undefined;
  let released = false;
  const acceptance = new TurnAcceptance(10, {
    write(signal) {
      quiescence = acceptance.quiesce();
      void quiescence?.then(() => {
        released = true;
      });
      expect(signal.aborted).toBe(true);
      return physical.promise;
    },
    acceptReady: vi.fn(),
    fail: vi.fn(),
  });
  const write = acceptance.submit();
  void write.catch(() => undefined);
  expect(quiescence).toBeInstanceOf(Promise);
  await Promise.resolve();
  expect(released).toBe(false);
  if (outcome === "resolve") physical.resolve();
  else physical.reject(new Error("physical failure"));
  await quiescence;
  expect(released).toBe(true);
  if (outcome === "resolve") await expect(write).resolves.toBeUndefined();
  else await expect(write).rejects.toThrow("physical failure");
});

test("C-API-48 synchronous writer failure settles its pre-registered quiescence token", async () => {
  let quiescence: Promise<void> | undefined;
  const acceptance = new TurnAcceptance(10, {
    write() {
      quiescence = acceptance.quiesce();
      throw new Error("synchronous write failure");
    },
    acceptReady: vi.fn(),
    fail: vi.fn(),
  });
  await expect(acceptance.submit()).rejects.toThrow("synchronous write failure");
  expect(quiescence).toBeInstanceOf(Promise);
  await expect(quiescence).resolves.toBeUndefined();
});
