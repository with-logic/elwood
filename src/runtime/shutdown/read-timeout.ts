/** Builds shutdown read deadline errors (PRD §5.3/§9.4, C-LIFE-10). */

/** Retain each read's diagnostic message with the shared deadline error code. */
export function processReadTimeout(message: string): Error {
  return Object.assign(new Error(message), { code: "ETIMEDOUT" });
}
