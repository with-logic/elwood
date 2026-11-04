/** Deterministic descriptor finalization without GC timing (PRD §8.1, C-API-61). */
import { closeSync, fstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { PublicationDirectory } from "../../src/state/publication-directory.ts";
import { tempDir } from "../helpers/tmp.ts";

const registry = vi.hoisted(() => {
  const state = {
    finalize: (_fd: number) => {},
    register: vi.fn<(target: object, fd: number, token: object) => void>(),
    unregister: vi.fn<(token: object) => boolean>(),
    failClose: false,
    failAfterClose: false,
  };
  vi.stubGlobal(
    "FinalizationRegistry",
    class {
      constructor(finalize: (fd: number) => void) {
        state.finalize = finalize;
      }
      register = state.register;
      unregister = state.unregister;
    },
  );
  return state;
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    closeSync: (fd: number) => {
      if (registry.failClose) throw new Error("close failed");
      actual.closeSync(fd);
      if (registry.failAfterClose) throw new Error("closed then failed");
    },
  };
});
afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  vi.clearAllMocks();
  registry.failClose = false;
  registry.failAfterClose = false;
});

function fixture() {
  const file = join(tempDir(), "record");
  const pin = new PublicationDirectory(file);
  const fd = registry.register.mock.calls[0]![1];
  return { pin, fd, file };
}

test("C-API-61 an abandoned pin finalizes only its numeric descriptor", () => {
  const { pin, fd } = fixture();
  expect(registry.register).toHaveBeenCalledWith(pin, fd, pin);
  registry.finalize(fd);
  expect(() => fstatSync(fd)).toThrowError(expect.objectContaining({ code: "EBADF" }));
});

test("C-API-61 finalizer close failures are contained; ordinary close unregisters", () => {
  const { pin, fd } = fixture();
  registry.failClose = true;
  expect(() => registry.finalize(fd)).not.toThrow();
  registry.failClose = false;
  pin.close();
  expect(registry.unregister).toHaveBeenCalledWith(pin);
  expect(() => fstatSync(fd)).toThrowError(expect.objectContaining({ code: "EBADF" }));
});

test("C-API-61 an ambiguous close never retries a descriptor reused by another file", () => {
  const { pin, fd, file } = fixture();
  registry.failAfterClose = true;
  expect(() => pin.close()).not.toThrow();
  registry.failAfterClose = false;
  const unrelated = openSync(join(tempDir(), "unrelated"), "w");
  try {
    expect(unrelated).toBe(fd);
    pin.close();
    expect(fstatSync(unrelated).isFile()).toBe(true);
    expect(registry.unregister).toHaveBeenCalledWith(pin);
    expect(() => pin.rollbackPath(file)).toThrow("Could not locate");
  } finally {
    try {
      closeSync(unrelated);
    } catch {
      /* A faulty repeated pin.close() may already have closed this reused descriptor. */
    }
  }
});
