/** Publishes optional discussion atomically; failed writes leave no partial context. */
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

export async function publishDiscussion(path, body, write = writeFile) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await write(temporary, body);
    await rename(temporary, path);
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}
