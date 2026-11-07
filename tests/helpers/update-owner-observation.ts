/**
 * Read barriers for deterministic update-owner interleavings (PRD §9.2, C-LIFE-09).
 * Import for side effects before runtime modules so their filesystem reads receive the mock.
 */
import { vi } from "vitest";

const observation = vi.hoisted(() => ({
  ownerPath: "",
  observed: false,
  afterRead: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...args);
      if (String(args[0]) === observation.ownerPath) {
        observation.observed = true;
        const after = observation.afterRead;
        observation.afterRead = undefined;
        await after?.();
      }
      return result;
    },
  };
});

export { observation };
