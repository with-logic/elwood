/**
 * Checks the lexical and physical lookup namespaces of an existing ignore parent before
 * staging/linking (PRD §8.1, C-STATE-11). Root/current-user entries and the CLI's mode-bit,
 * private-group and sticky rules prevent other users redirecting those lookups. This
 * is not same-user/root isolation, an ACL audit, or executable-selection authorization.
 */
import { isUtf8 } from "node:buffer";
import { lstatSync, readlinkSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { elwoodError } from "../../core/errors.ts";
import { lookupFault, ownerFault, type PathUser } from "../../core/path-trust.ts";

const MAX_LINKS = 40;

/** `path` is the existing parent directory, e.g. dirname(gitignorePath); no trust is cached. */
export function assertTrustedIgnoreParent(path: string): void {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined)
    corrupt("POSIX path ownership could not be determined.");
  // Do not resolve/normalize first: even a component followed by '..' must be trusted.
  const absolute = isAbsolute(path) ? path : `${process.cwd()}/${path}`;
  const user = { uid, gid };
  let current = "/";
  const pending = namesOf(absolute);
  let links = 0;
  assertDirectory(lstatSync(current), user, current);
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (name === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, name);
    const info = lstatSync(next);
    if (info.isSymbolicLink()) {
      const fault = ownerFault(info, user, next, "link");
      if (fault !== undefined) corrupt(fault);
      if (++links > MAX_LINKS) corrupt(`Too many symbolic links while inspecting '${next}'.`);
      const target = readlinkSync(next, { encoding: "buffer" });
      if (!isUtf8(target)) corrupt(`Symbolic link '${next}' has a non-UTF-8 target.`);
      const text = target.toString("utf8");
      pending.push(...namesOf(text));
      if (isAbsolute(text)) {
        current = "/";
        assertDirectory(lstatSync(current), user, current);
      }
      continue;
    }
    assertDirectory(info, user, next);
    current = next;
  }
}

function assertDirectory(info: Stats, user: PathUser, path: string): void {
  if (!info.isDirectory()) corrupt(`State ancestor component is not a directory: ${path}`);
  const fault = lookupFault(info, user, path);
  if (fault !== undefined) corrupt(fault);
}

function corrupt(reason: string): never {
  throw elwoodError("state_corrupt", `Cannot trust state ancestor: ${reason}`);
}

function namesOf(path: string): string[] {
  return path
    .split("/")
    .filter((name) => name !== "" && name !== ".")
    .reverse();
}
