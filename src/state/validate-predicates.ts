/**
 * Low-level predicates for persisted session-record validation (PRD §8.2, §10).
 * These are the shared trust-boundary primitives from `core/predicates.ts`,
 * re-exported under the state module so validate.ts and validate-posture.ts share
 * one definition with hook-payload and CLI-config validation.
 */

export { isRecord, isString, isStringArray } from "../core/predicates.ts";
