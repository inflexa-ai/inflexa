import { describe, expect, onTestFinished, test } from "bun:test";

import { replaceProperty, type ReplacePropertyOpts } from "../replace_property.ts";

/** Options whose restores the test runs itself, so each case checks the state right after its own restore. */
function manualRestores(): { opts: ReplacePropertyOpts; restoreAll: () => void; registered: () => number } {
    const restores: Array<() => void> = [];
    return {
        opts: { registerRestore: (restore) => restores.push(restore) },
        restoreAll: () => {
            // The order of Bun's `onTestFinished` callbacks: registration order.
            for (const restore of restores) restore();
        },
        registered: () => restores.length,
    };
}

describe("replaceProperty", () => {
    test("replaces an own property, and the restore puts the original descriptor back", () => {
        const target = { flag: true };
        const originalDescriptor = Object.getOwnPropertyDescriptor(target, "flag");
        const { opts, restoreAll } = manualRestores();

        replaceProperty(target, "flag", false, opts);
        expect(target.flag).toBe(false);

        restoreAll();
        expect(Object.getOwnPropertyDescriptor(target, "flag")).toEqual(originalDescriptor);
        target.flag = false;
        expect(target.flag).toBe(false);
    });

    test("deletes the own property on restore when the object had none", () => {
        const target: { flag?: boolean } = {};
        const { opts, restoreAll } = manualRestores();

        replaceProperty(target, "flag", true, opts);
        expect(Object.getOwnPropertyDescriptor(target, "flag")?.value).toBe(true);

        restoreAll();
        expect(Object.getOwnPropertyDescriptor(target, "flag")).toBeUndefined();
        target.flag = true;
        expect(target.flag).toBe(true);
    });

    test("shows the getter of the prototype again after the restore", () => {
        class Stream {
            get isTTY(): boolean {
                return false;
            }
        }
        const target = new Stream();
        const { opts, restoreAll } = manualRestores();

        replaceProperty(target, "isTTY", true, opts);
        expect(target.isTTY).toBe(true);

        restoreAll();
        expect(target.isTTY).toBe(false);
        expect(Object.getOwnPropertyDescriptor(target, "isTTY")).toBeUndefined();
    });

    test("two replacements of one key come back to the state before the first", () => {
        const target = { flag: "original" };
        const originalDescriptor = Object.getOwnPropertyDescriptor(target, "flag");
        const { opts, restoreAll, registered } = manualRestores();

        replaceProperty(target, "flag", "first", opts);
        replaceProperty(target, "flag", "second", opts);
        expect(target.flag).toBe("second");
        expect(registered()).toBe(1);

        restoreAll();
        expect(Object.getOwnPropertyDescriptor(target, "flag")).toEqual(originalDescriptor);
        target.flag = "assigned";
        expect(target.flag).toBe("assigned");
    });

    test("a replacement after a restore registers a new restore", () => {
        const target = { flag: "original" };
        const { opts, restoreAll, registered } = manualRestores();

        replaceProperty(target, "flag", "first", opts);
        restoreAll();
        replaceProperty(target, "flag", "second", opts);

        expect(registered()).toBe(2);
    });

    test("restores itself at the end of the test with the default options", () => {
        const target = { flag: "original" };
        replaceProperty(target, "flag", "replaced");
        expect(target.flag).toBe("replaced");
        // Registered after the replacement, thus Bun runs it after the restore of the helper.
        onTestFinished(() => {
            expect(target.flag).toBe("original");
        });
    });
});
