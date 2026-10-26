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
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { pathReplacementReason } from "../../src/cli/request/path-replacement.ts";
import { validateWorkspace } from "../../src/cli/request/workspace.ts";
import { CliValidationError } from "../../src/cli/validation-error.ts";
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

/** A CLI usage error, which exits with status 2, with `message`. */
const usageError = (message: string) => ({ code: "invalid_arguments", message });

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

  test("accepts /tmp itself for root, who owns it", async () => {
    const root = vi.spyOn(process, "getuid").mockReturnValue(0);
    onTestFinished(() => root.mockRestore());
    await expect(validateWorkspace("/tmp")).resolves.toBe("/tmp");
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

  // Root's own directories and links pass for anyone, so a root run has no stranger to find.
  test.skipIf(user.uid === 0)("names a directory or link another user owns", async () => {
    const stranger = { uid: user.uid + 1, gid: user.gid };
    const dir = tempDir();
    mkdirSync(join(dir, "ws"));
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
    const validation = validateWorkspace(ws);
    await expect(validation).rejects.toBeInstanceOf(CliValidationError);
    await expect(validation).rejects.toMatchObject(
      usageError(
        `Workspace '${ws}' could not be inspected: symbolic link '${realpathSync(base)}/link' does not point to a UTF-8 path; point it at one, or choose a workspace reached without it.`,
      ),
    );
  });

  test.each([
    { past: "private directories", mode: 0o755 },
    { past: "a directory others can write", mode: 0o777 },
  ])("a symlink loop past $past fails as uninspectable, naming the link past the limit", async ({
    mode,
  }) => {
    // The real path, so no system link such as macOS's /var is among those counted.
    const shared = join(realpathSync(tempDir()), "shared");
    mkdirSync(shared);
    symlinkSync("b", join(shared, "a"));
    symlinkSync("a", join(shared, "b"));
    chmodSync(shared, mode);
    const ws = join(shared, "a", "ws");
    // The walk follows a, b, a, ...; the 41st link is `a`, named even past a refused directory.
    const validation = validateWorkspace(ws);
    await expect(validation).rejects.toBeInstanceOf(CliValidationError);
    await expect(validation).rejects.toMatchObject(
      usageError(
        `Workspace '${ws}' could not be inspected: symbolic link '${shared}/a' is past the 40 links a path may follow, as in a loop; fix the links, or choose a workspace reached without them.`,
      ),
    );
  });
});
