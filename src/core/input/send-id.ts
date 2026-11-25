/** Bound caller-supplied correlation metadata at the API boundary (PRD §5.4, C-API-70). */
import { runContained } from "../contained.ts";
import type { SendOptions } from "../images/types.ts";

export function readSendId(options: SendOptions | undefined): string | undefined {
  let id: unknown;
  runContained(() => {
    id = options?.sendId;
  });
  return typeof id === "string" && id.length <= 1_024 ? id : undefined;
}
