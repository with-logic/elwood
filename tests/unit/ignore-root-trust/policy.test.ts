/** Shared path-owner/mode policy remains CLI-compatible (C-STATE-11/C-CLI-15). */
import { expect, test } from "vitest";
import { lookupFault, ownerFault } from "../../../src/core/path-trust.ts";

const user = { uid: 1000, gid: 1000 };
const info = (uid: number, gid: number, mode: number) => ({ uid, gid, mode });

test("C-STATE-11 trusted owners, sticky parents and private groups retain the existing policy", () => {
  expect(lookupFault(info(0, 0, 0o755), user, "/root")).toBeUndefined();
  expect(lookupFault(info(1000, 1000, 0o775), user, "/private-group")).toBeUndefined();
  expect(lookupFault(info(0, 0, 0o1777), user, "/tmp")).toBeUndefined();
  expect(lookupFault(info(1000, 1000, 0o777), user, "/world")).toMatch(/writable by other/);
  expect(lookupFault(info(1000, 50, 0o775), user, "/shared")).toMatch(/writable by other/);
  expect(lookupFault(info(501, 20, 0o775), { uid: 501, gid: 20 }, "/staff")).toMatch(
    /writable by other/,
  );
  expect(lookupFault(info(0, 0, 0o775), { uid: 0, gid: 0 }, "/root-group")).toMatch(
    /writable by other/,
  );
  expect(lookupFault(info(1001, 1000, 0o1777), user, "/theirs")).toMatch(/owned by another/);
  expect(ownerFault({ uid: 0 }, user, "/link", "link")).toBeUndefined();
  expect(ownerFault({ uid: 1000 }, user, "/link", "link")).toBeUndefined();
  expect(ownerFault({ uid: 1001 }, user, "/link", "link")).toMatch(/link.*owned by another/);
});
