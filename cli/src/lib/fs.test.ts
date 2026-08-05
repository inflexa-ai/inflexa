import { describe, expect, test } from "bun:test";
import type { Stats } from "node:fs";

import { isReadableBy, type ProcessIdentity } from "./fs.ts";

// Only the four fields `isReadableBy` reads. A cast is the pragmatic shape here: constructing a real
// `Stats` means touching the filesystem, which would test the OS rather than the class resolution.
function statLike(mode: number, uid: number, gid: number): Stats {
    return { mode, uid, gid } as Stats;
}

const ME: ProcessIdentity = { uid: 501, gid: 20, groups: [20, 12] };

describe("isReadableBy", () => {
    test("the owner class decides for the owner, and it can DENY", () => {
        expect(isReadableBy(statLike(0o600, 501, 20), ME)).toBe(true);
        // POSIX resolves exactly one class: matching the owner means the group and other bits are
        // never consulted, so a 0044 file owned by this user is unreadable to it despite `r` twice.
        expect(isReadableBy(statLike(0o044, 501, 20), ME)).toBe(false);
    });

    test("the group class covers a supplementary group, not just the effective gid", () => {
        expect(isReadableBy(statLike(0o040, 0, 20), ME)).toBe(true);
        // gid 12 is supplementary — reachable only through `getgroups()`.
        expect(isReadableBy(statLike(0o040, 0, 12), ME)).toBe(true);
        expect(isReadableBy(statLike(0o040, 0, 99), ME)).toBe(false);
    });

    test("the other class is the fallback for an unrelated file", () => {
        expect(isReadableBy(statLike(0o004, 0, 0), ME)).toBe(true);
        expect(isReadableBy(statLike(0o600, 0, 0), ME)).toBe(false);
    });

    test("root reads regardless of the bits", () => {
        const root: ProcessIdentity = { uid: 0, gid: 0, groups: [0] };
        expect(isReadableBy(statLike(0o000, 501, 20), root)).toBe(true);
    });

    test("the file type bits do not leak into the decision", () => {
        // A real `st_mode` carries S_IFDIR/S_IFREG above the permission bits; masking must ignore them.
        const dirMode = 0o040000 | 0o750;
        expect(isReadableBy(statLike(dirMode, 501, 20), ME)).toBe(true);
        expect(isReadableBy(statLike(0o040000 | 0o310, 501, 20), ME)).toBe(false);
    });
});
