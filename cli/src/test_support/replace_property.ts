import { onTestFinished } from "bun:test";

/** What `replaceProperty` needs from its caller: where the restore of a test runs. */
export type ReplacePropertyOpts = {
    /** Called once for each (object, key) replaced in a test, with the function that puts the original state back. */
    registerRestore: (restore: () => void) => void;
};

export const DEFAULT_REPLACE_PROPERTY_OPTS: ReplacePropertyOpts = { registerRestore: onTestFinished };

// The keys that the current test replaced. An entry lives from the first replacement of a key until its
// restore runs, which is the end of the test with the default options.
const replaced = new WeakMap<object, Set<PropertyKey>>();

/**
 * Replace one property of `target` with `value` until the end of the current test. Call it inside a test
 * or a `beforeEach`.
 *
 * The new property is an own, enumerable, writable, and configurable data property. A `defineProperty`
 * with `{ value, configurable: true }` makes the property read-only, and for `process.stdin` or
 * `process.stderr` (`isTTY`, `columns`, `write`) that leaks into every later test file of the process.
 *
 * The first replacement of a key keeps the own descriptor that the object had, and registers one restore.
 * A later replacement of the same key in the same test only defines the new value, so the restore always
 * gives back the state from before the test, whatever the order in which the restores run (Bun runs the
 * `onTestFinished` callbacks in the order of registration). The restore defines the saved descriptor
 * again, or deletes the own property when the object had none, so a getter on the prototype (for example
 * `isTTY` of a stream) is visible again.
 */
export function replaceProperty<T extends object, K extends keyof T>(
    target: T,
    key: K,
    value: T[K],
    opts: ReplacePropertyOpts = DEFAULT_REPLACE_PROPERTY_OPTS,
): void {
    let keys = replaced.get(target);
    if (keys === undefined) {
        keys = new Set();
        replaced.set(target, keys);
    }
    if (!keys.has(key)) {
        const original = Object.getOwnPropertyDescriptor(target, key);
        const registry = keys;
        registry.add(key);
        opts.registerRestore(() => {
            if (original === undefined) Reflect.deleteProperty(target, key);
            else Object.defineProperty(target, key, original);
            registry.delete(key);
        });
    }
    Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: true });
}
