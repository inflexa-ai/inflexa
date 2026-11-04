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
 * A user-supplied reference to an entity by either its {@link ID} or its human name/slug —
 * what a command receives from `inflexa resume <x>`, `--analysis <x>`, etc. A named alias (not a
 * bare `string`) so a parameter's intent is legible: "resolve this by id OR name". Resolution
 * is always a SINGLE id-priority query, never fetch-by-id-then-by-name — see CLAUDE.md →
 * "Resolving an id-or-name reference".
 */
export type IdOrName = string;

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
 * Length is measured in code points (`Array.from(s).length`), not UTF-16 units, so an emoji
 * counts once rather than twice.
 */
export function str256(s: string): Result<Str256, Str256Error> {
    const trimmed = s.trim();
    const len = Array.from(trimmed).length;
    if (len === 0) return err("empty");
    if (len > 256) return err("too_long");
    // SAFETY: the two checks above reject an empty and an over-long `trimmed`, which are the bounds that the brand states.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the brand has no runtime form that a guard could check
    return ok(trimmed as Str256);
}

/**
 * Brand a string already known to satisfy the {@link Str256} bound (e.g. a value read
 * back from the DB), skipping validation. Use only when the source guarantees validity.
 */
export function asStr256(s: string): Str256 {
    // SAFETY: the caller states that its source already enforced the bounds of `Str256`, and the brand has no runtime form.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the brand has no runtime form that a guard could check
    return s as Str256;
}

/**
 * Whether `value` is one of `members`, narrowing it to the member type. The tuple of a closed set is
 * widened to `readonly string[]` through an annotation, because `.includes` on the literal tuple
 * accepts only a member, which is the very thing under test.
 */
export function isMember<T extends string>(members: readonly T[], value: string): value is T {
    const widened: readonly string[] = members;
    return widened.includes(value);
}

/**
 * The own enumerable string keys of `table`, typed as the keys of its type. `Object.keys` widens to
 * `string[]`, while `for...in` over a generic `T` types its key as `Extract<keyof T, string>`. The
 * own-property test keeps the result equal to `Object.keys`.
 */
export function keysOf<T extends object>(table: T): (keyof T & string)[] {
    const keys: (keyof T & string)[] = [];
    for (const key in table) {
        if (Object.hasOwn(table, key)) keys.push(key);
    }
    return keys;
}
