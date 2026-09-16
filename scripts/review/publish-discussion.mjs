/** Publishes optional discussion atomically; failed writes leave no partial context. */
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

export async function publishDiscussion(path, body, write = writeFile) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await write(temporary, body);
    await rename(temporary, path);
  } catch (error) {
    const results = await Promise.allSettled([
      rm(path, { force: true }),
      rm(temporary, { force: true }),
    ]);
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length)
      throw new AggregateError([error, ...failures], "Discussion publication and cleanup failed", {
        cause: error,
      });
    throw error;
  }
}
