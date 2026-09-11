/**
 * Strict typed-field primitives shared by the version-1 config codec.
 * Implements PRD §12A.4 and C-CLI-13/C-CLI-14.
 */

import { CliValidationError } from "../types.ts";

export function optionalString<K extends string>(
  object: Record<string, unknown>,
  key: K,
): { readonly [P in K]?: string } {
  if (!(key in object)) return {};
  const value = object[key];
  if (typeof value !== "string" || value.trim() === "")
    throw invalid(`${key} must be a non-empty string.`);
  return { [key]: value } as { readonly [P in K]?: string };
}

export function optionalBoolean<K extends string>(
  object: Record<string, unknown>,
  key: K,
): { readonly [P in K]?: boolean } {
  if (!(key in object)) return {};
  if (typeof object[key] !== "boolean") throw invalid(`${key} must be true or false.`);
  return { [key]: object[key] } as { readonly [P in K]?: boolean };
}

export function optionalEnum<K extends string, V extends string>(
  object: Record<string, unknown>,
  key: K,
  valid: readonly V[],
): { readonly [P in K]?: V } {
  if (!(key in object)) return {};
  return { [key]: oneOf(object[key], valid, key) } as { readonly [P in K]?: V };
}

export function oneOf<V extends string>(value: unknown, valid: readonly V[], key: string): V {
  if (typeof value !== "string" || !valid.includes(value as V))
    throw invalid(`${key} must be one of: ${valid.join(", ")}.`);
  return value as V;
}

export function strictBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalid("Boolean values must be true or false.");
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

export function exactKeys(
  object: Record<string, unknown>,
  valid: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(object).find((key) => !valid.includes(key));
  if (unknown !== undefined) throw invalid(`Unknown ${label} key: ${unknown}.`);
}

export function invalid(message: string): CliValidationError {
  return new CliValidationError("invalid_config", message);
}
