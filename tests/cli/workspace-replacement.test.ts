/**
 * A workspace another user could replace before launch is refused, on the real filesystem:
 * every directory the path is looked up through, including through symlinks, must be owned by
 * root or the user, and its mode bits must grant write to no one else unless it is sticky or
 * its group is the user's private group (PRD §12A.5, C-CLI-15). Those are the only checks: a
 * passing path may still be writable by another member of that group, or through an ACL.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { lookupFault, pathReplacementReason } from "../../src/cli/request/path-replacement.ts";
import { validateWorkspace } from "../../src/cli/request/workspace.ts";
import { tempDir } from "../helpers/tmp.ts";

const user = { uid: process.getuid!(), gid: process.getgid!() };
/**
 * Whether the user's primary group passes as their private group: numbered like them, and not
 * root's. A directory only that group can write then passes; who else is in it is not checked.
 */
const privateGroup = user.uid !== 0 && user.gid === user.uid;

/** A workspace `ws` under a fresh `shared` directory given `mode`; returns both. */
function sharedWorkspace(mode: number) {
  const shared = join(tempDir(), "shared");
  mkdirSync(join(shared, "ws"), { recursive: true });
  chmodSync(shared, mode);
  // Faults name the directory as the walk reached it, through the temp directory's links.
  return { shared: realpathSync(shared), ws: join(shared, "ws") };
}

/**
 * `<base>/shared/link/ws`, where `link` points at the user's private `<base>/proj`, so the real
 * path `<base>/proj/ws` passes and only the directory the link lives in can fail.
 */
type Target = "absolute" | "relative";

function linkedWorkspace(mode: number, target: Target) {
  const base = tempDir();
  const proj = join(base, "proj");
  mkdirSync(join(proj, "ws"), { recursive: true, mode: 0o700 });
  const shared = join(base, "shared");
  mkdirSync(shared);
  symlinkSync(target === "absolute" ? proj : "../proj", join(shared, "link"));
  chmodSync(shared, mode);
  return { shared: realpathSync(shared), ws: join(shared, "link", "ws") };
}

const refusal = (path: string) =>
  `Workspace '${path}' could be replaced by another user: directory`;
const writableFix =
  "is writable by other users; remove that with 'chmod go-w', or choose a workspace elsewhere.";

describe("C-CLI-15 workspace replacement", () => {
  test("accepts /tmp, the temp directory and its real path, and the home directory", async () => {
    const inTmp = mkdtempSync("/tmp/elwood-trust-");
    onTestFinished(() => rmSync(inTmp, { recursive: true, force: true }));
    const inTemp = tempDir();
    for (const path of [inTmp, inTemp, realpathSync(inTemp), userInfo().homedir])
      await expect(validateWorkspace(path)).resolves.toBe(path);
  });

  test.skipIf(user.uid === 0)("refuses /tmp itself, which root owns", async () => {
    await expect(validateWorkspace("/tmp")).rejects.toThrow(
      "Workspace '/tmp' must be owned by the current user.",
    );
  });

  test("refuses a workspace in a directory others can write unless it is sticky", async () => {
    const open = sharedWorkspace(0o777);
    await expect(validateWorkspace(open.ws)).rejects.toThrow(
      `${refusal(open.ws)} '${open.shared}' ${writableFix}`,
    );
    const sticky = sharedWorkspace(0o1777);
    await expect(validateWorkspace(sticky.ws)).resolves.toBe(sticky.ws);
  });

  test.skipIf(privateGroup)("refuses a workspace in a group-writable directory", async () => {
    const { shared, ws } = sharedWorkspace(0o775);
    await expect(validateWorkspace(ws)).rejects.toThrow(
      `${refusal(ws)} '${shared}' ${writableFix}`,
    );
  });

  type LinkCase = {
    readonly writers: "others" | "the group";
    readonly mode: number;
    readonly target: Target;
  };
  const linkCases: readonly LinkCase[] = [
    { writers: "others", mode: 0o777, target: "absolute" },
    { writers: "others", mode: 0o777, target: "relative" },
    ...(privateGroup ? [] : [{ writers: "the group", mode: 0o775, target: "absolute" } as const]),
  ];
  test.each(
    linkCases,
  )("refuses a link in a directory $writers can write to a private $target workspace", async ({
    mode,
    target,
  }) => {
    const { shared, ws } = linkedWorkspace(mode, target);
    await expect(validateWorkspace(ws)).rejects.toThrow(
      `${refusal(ws)} '${shared}' is writable by other users`,
    );
  });

  test("follows links and parent names through private directories", async () => {
    const base = tempDir();
    mkdirSync(join(base, "proj", "ws"), { recursive: true });
    symlinkSync(join(base, "proj"), join(base, "link"));
    for (const path of [join(base, "link", "ws"), `${base}/proj/../link/ws`])
      await expect(validateWorkspace(path)).resolves.toBe(path);
  });

  test("names a directory or link another user owns", async () => {
    const stranger = { uid: user.uid + 1, gid: user.gid };
    const dir = tempDir();
    expect(await pathReplacementReason(join(dir, "ws"), stranger)).toMatch(
      /^directory '.+' is owned by another user; choose a workspace reached only through/u,
    );
    // /tmp and its real path are root's, so the walk reaches the link the user made there.
    const link = `/tmp/elwood-trust-link-${randomUUID()}`;
    onTestFinished(() => unlinkSync(link));
    symlinkSync(dir, link);
    expect(await pathReplacementReason(join(link, "ws"), stranger)).toBe(
      `link '${realpathSync("/tmp")}/${basename(link)}' is owned by another user; choose a workspace reached only through your own or root's directories`,
    );
  });

  test("a link to a path that is not UTF-8 fails, naming the link, instead of checking its decoded alias", async () => {
    const base = tempDir();
    // What the byte 0xff decodes to, U+FFFD, names a private directory the walk would accept.
    mkdirSync(join(base, "\uFFFD", "ws"), { recursive: true });
    const link = join(base, "link");
    symlinkSync(Buffer.concat([Buffer.from(`${base}/`), Buffer.from([0xff])]), link);
    const ws = join(link, "ws");
    await expect(validateWorkspace(ws)).rejects.toThrow(
      `Workspace '${ws}' could not be inspected: symbolic link '${realpathSync(base)}/link' does not point to a UTF-8 path; point it at one, or choose a workspace reached without it.`,
    );
  });

  test("a symlink loop fails as uninspectable, naming the link past the limit", async () => {
    // The real path, so no system link such as macOS's /var is among those counted.
    const base = realpathSync(tempDir());
    symlinkSync("b", join(base, "a"));
    symlinkSync("a", join(base, "b"));
    const ws = join(base, "a", "ws");
    // The walk follows a, b, a, ...; the 41st link is `a`.
    await expect(validateWorkspace(ws)).rejects.toThrow(
      `Workspace '${ws}' could not be inspected: symbolic link '${base}/a' is past the 40 links a path may follow, as in a loop; fix the links, or choose a workspace reached without them.`,
    );
  });
});

describe("C-CLI-15 group-writable directories", () => {
  const groupWritable = (uid: number, gid: number) => ({ uid, gid, mode: 0o40775 });

  test("are private to a user whose primary group is their own, numbered like them", () => {
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
