/**
 * The owner and mode-bit rules for one directory a workspace path is looked up in, on synthetic
 * metadata, so each holds for users and groups the test runner cannot be (PRD §12A.5,
 * C-CLI-15). Only owners and mode bits are checked: group membership and ACLs are not.
 */

import { describe, expect, test } from "vitest";
import { lookupFault } from "../../src/cli/request/path-replacement.ts";

const directory = (uid: number, gid: number, mode: number) => ({ uid, gid, mode: 0o40000 | mode });
const groupWritable = (uid: number, gid: number) => directory(uid, gid, 0o775);

describe("C-CLI-15 group-writable directories", () => {
  test("pass for a user whose primary group is numbered like them, as their private group", () => {
    const linux = { uid: 1000, gid: 1000 };
    expect(lookupFault(groupWritable(1000, 1000), linux, "/home/alice/code")).toBeUndefined();
    expect(lookupFault(groupWritable(1000, 50), linux, "/srv/team")).toMatch(/writable by other/u);
  });

  test("are shared when the primary group is not numbered like the user, as macOS staff", () => {
    const macos = { uid: 501, gid: 20 };
    expect(lookupFault(groupWritable(501, 20), macos, "/Users/me/code")).toMatch(
      /writable by other users/u,
    );
  });

  test("are shared when the group is root's group 0, though root is numbered like it", () => {
    const root = { uid: 0, gid: 0 };
    expect(lookupFault(groupWritable(0, 0), root, "/srv/shared")).toMatch(
      /writable by other users/u,
    );
  });
});

describe("C-CLI-15 directory owners", () => {
  const user = { uid: 1000, gid: 1000 };

  test("a directory another user owns is named, even one no one else can write", () => {
    expect(lookupFault(directory(1001, 1001, 0o755), user, "/srv/theirs")).toBe(
      "directory '/srv/theirs' is owned by another user; choose a workspace reached only through your own or root's directories",
    );
  });

  test("the user's own directories and root's pass", () => {
    expect(lookupFault(directory(1000, 1000, 0o755), user, "/home/alice")).toBeUndefined();
    expect(lookupFault(directory(0, 0, 0o755), user, "/home")).toBeUndefined();
  });
});
