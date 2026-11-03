import { expect } from "bun:test";

/**
 * The asymmetric matchers of `expect`, typed `unknown`. bun-types types each one as `any`, so a
 * matcher inside an expected object would be an unchecked `any` at every call site. A matcher is
 * a placeholder that `expect` resolves, never a value of the type it stands for. Thus a
 * `toEqual` against a typed actual value takes `expect<unknown>(actual)`.
 */

/** Matches any value that `constructor` created (`expect.any`). */
export function anyOf(constructor: Parameters<typeof expect.any>[0]): unknown {
    return expect.any(constructor);
}

/** Matches any value that is not `null` or `undefined` (`expect.anything`). */
export function anything(): unknown {
    return expect.anything();
}

/** Matches an array that holds each of `items`, in any order and with other items (`expect.arrayContaining`). */
export function arrayContaining(items: readonly unknown[]): unknown {
    return expect.arrayContaining(items);
}

/** Matches an object that holds each property of `subset` (`expect.objectContaining`). */
export function objectContaining(subset: object): unknown {
    return expect.objectContaining(subset);
}

/** Matches a string that contains `text` (`expect.stringContaining`). */
export function stringContaining(text: string): unknown {
    return expect.stringContaining(text);
}
