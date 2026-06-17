import { type Result, ok, err } from "neverthrow";

/**
 * A time-sortable `randomUUIDv7()`. The single id scheme for everything — DB row ids,
 * the write-once anchor marker, event ids. Every `XxxId` domain alias resolves to this,
 * so the uuidv7 contract is documented here once instead of on every id field.
 *
 * Mint inline with `randomUUIDv7()` at the call site (see CLAUDE.md) — there is no
 * `makeID()` wrapper, since a function whose whole body is `return randomUUIDv7()` is
 * pointless ceremony.
 */
export type ID = string;

/**
 * A trimmed, non-empty string of at most 256 Unicode code points. The brand is the proof
 * that {@link str256} validated it, so a value typed `Str256` is known to satisfy the
 * length bound — construct one only via {@link str256} (validating) or {@link asStr256}
 * (trusted sources).
 */
export type Str256 = string & { readonly __str256: unique symbol };

/** Why a candidate string failed {@link str256} validation. */
export type Str256Error = "empty" | "too_long";

/**
 * Validate `s` as a {@link Str256}: trim it, then require 1–256 code points.
 *
 * Length is measured in code points (`[...s].length`), not UTF-16 units, so an emoji
 * counts once rather than twice.
 */
export function str256(s: string): Result<Str256, Str256Error> {
    const trimmed = s.trim();
    const len = [...trimmed].length;
    if (len === 0) return err("empty");
    if (len > 256) return err("too_long");
    return ok(trimmed as Str256);
}

/**
 * Brand a string already known to satisfy the {@link Str256} bound (e.g. a value read
 * back from the DB), skipping validation. Use only when the source guarantees validity.
 */
export function asStr256(s: string): Str256 {
    return s as Str256;
}
