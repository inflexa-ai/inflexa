import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { countFolderEntries, entryDetails, readFolder, scanFolder, type FolderEntry } from "./folder_listing.ts";
import { processIdentity } from "./fs.ts";

let root = "";

// A case-insensitive volume (the macOS default) stores `A.txt` and `a.txt` as one file, so the tiebreak
// has nothing to order there.
const CASE_INSENSITIVE_VOLUME = (() => {
    const probe = mkdtempSync(join(tmpdir(), "inflexa-case-"));
    try {
        writeFileSync(join(probe, "a"), "x");
        writeFileSync(join(probe, "A"), "x");
        return readdirSync(probe).length === 1;
    } finally {
        rmSync(probe, { recursive: true, force: true });
    }
})();

beforeEach(() => {
    // realpath so path assertions match the canonical paths of `readFolder` (macOS /var -> /private/var).
    root = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-listing-")));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

async function read(path: string, hidden = false): Promise<Awaited<ReturnType<typeof readFolder>>> {
    return readFolder(path, hidden);
}

function entryNamed(entries: FolderEntry[], name: string): FolderEntry {
    const entry = entries.find((e) => e.name === name);
    if (!entry) throw new Error(`no entry named ${name}`);
    return entry;
}

describe("readFolder", () => {
    test("sorts each folder first, then each other entry, with a link to a folder in the second group", async () => {
        const outside = join(root, "outside");
        mkdirSync(outside);
        const dir = join(root, "dir");
        mkdirSync(dir);
        mkdirSync(join(dir, "beta"));
        mkdirSync(join(dir, "Gamma"));
        writeFileSync(join(dir, "alpha.txt"), "x");
        writeFileSync(join(dir, "Zeta.txt"), "x");
        symlinkSync(outside, join(dir, "ext"));

        const folder = (await read(dir))._unsafeUnwrap();
        expect(folder.entries.map((e) => [e.name, e.kind])).toEqual([
            ["beta", "folder"],
            ["Gamma", "folder"],
            ["alpha.txt", "file"],
            ["ext", "symlink"],
            ["Zeta.txt", "file"],
        ]);
    });

    test.skipIf(CASE_INSENSITIVE_VOLUME)("orders two names that differ only in case the same way on each read", async () => {
        const dir = join(root, "dir");
        mkdirSync(dir);
        for (const name of ["b.txt", "a.txt", "A.txt", "B.txt"]) writeFileSync(join(dir, name), "x");

        const names = (await read(dir))._unsafeUnwrap().entries.map((e) => e.name);
        expect(names).toEqual(["A.txt", "a.txt", "B.txt", "b.txt"]);
        expect((await read(dir))._unsafeUnwrap().entries.map((e) => e.name)).toEqual(names);
    });

    test("orders two names that the collator calls equal by their code units, on any volume", async () => {
        const dir = join(root, "dir");
        mkdirSync(dir);
        // The base-sensitivity collator ignores the accent, thus `e.txt` and `\u00e9.txt` tie.
        for (const name of ["\u00e9.txt", "e.txt", "f.txt"]) writeFileSync(join(dir, name), "x");

        const names = (await read(dir))._unsafeUnwrap().entries.map((e) => e.name.normalize("NFC"));
        expect(names).toEqual(["e.txt", "\u00e9.txt", "f.txt"]);
    });

    test("drops the hidden entries by default, shows them on request, and counts the raw read", async () => {
        writeFileSync(join(root, "a.txt"), "x");
        writeFileSync(join(root, ".env"), "x");
        mkdirSync(join(root, ".git"));

        const hiddenOff = (await read(root, false))._unsafeUnwrap();
        expect(hiddenOff.entries.map((e) => e.name)).toEqual(["a.txt"]);
        expect(hiddenOff.rawCount).toBe(3);

        const hiddenOn = (await read(root, true))._unsafeUnwrap();
        expect(hiddenOn.entries.map((e) => [e.name, e.hidden])).toEqual([
            [".git", true],
            [".env", true],
            ["a.txt", false],
        ]);
        expect(hiddenOn.rawCount).toBe(3);
    });

    test("gives the canonical path through a link, and the entry paths under it", async () => {
        const real = join(root, "real");
        mkdirSync(real);
        writeFileSync(join(real, "f.txt"), "x");
        symlinkSync(real, join(root, "l"));

        const folder = (await read(join(root, "l")))._unsafeUnwrap();
        expect(folder.path).toBe(real);
        expect(folder.entries.map((e) => e.path)).toEqual([join(real, "f.txt")]);
    });

    test("gives `absent` for a path that does not exist", async () => {
        const missing = join(root, "missing");
        const error = (await read(missing))._unsafeUnwrapErr();
        expect(error).toMatchObject({ type: "absent", path: missing });
        expect(error.cause).toMatchObject({ code: "ENOENT" });
    });

    test("gives `not_folder` for a file", async () => {
        const file = join(root, "f.txt");
        writeFileSync(file, "x");
        const error = (await read(file))._unsafeUnwrapErr();
        expect(error).toMatchObject({ type: "not_folder", path: file });
        expect(error.cause).toMatchObject({ code: "ENOTDIR" });
    });

    test.skipIf(process.getuid?.() === 0)("gives `unreadable` for a folder with mode 000", async () => {
        const locked = join(root, "locked");
        mkdirSync(locked);
        chmodSync(locked, 0o000);
        try {
            const error = (await read(locked))._unsafeUnwrapErr();
            expect(error).toMatchObject({ type: "unreadable", path: locked });
            expect(error.cause).toMatchObject({ code: "EACCES" });
        } finally {
            chmodSync(locked, 0o755);
        }
    });
});

describe("scanFolder and countFolderEntries", () => {
    function seed(): void {
        writeFileSync(join(root, "a.txt"), "x");
        writeFileSync(join(root, "b.txt"), "x");
        writeFileSync(join(root, ".env"), "x");
        mkdirSync(join(root, "sub"));
    }

    test("counts the entries and drops the hidden ones by default", async () => {
        seed();
        expect((await countFolderEntries(root, false))._unsafeUnwrap()).toBe(3);
    });

    test("counts the hidden entries when asked", async () => {
        seed();
        expect((await countFolderEntries(root, true))._unsafeUnwrap()).toBe(4);
    });

    test("counts the same entries as the length of readFolder", async () => {
        seed();
        for (const hidden of [false, true]) {
            const read = (await readFolder(root, hidden))._unsafeUnwrap();
            expect((await countFolderEntries(root, hidden))._unsafeUnwrap()).toBe(read.entries.length);
        }
    });

    test("gives the entries after the hidden filter to visit, with their type and path", async () => {
        seed();
        const seen: FolderEntry[] = [];
        const count = (await scanFolder(root, false, (entry) => seen.push(entry)))._unsafeUnwrap();
        expect(count).toBe(3);
        expect(seen.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
            { name: "a.txt", path: join(root, "a.txt"), kind: "file", hidden: false },
            { name: "b.txt", path: join(root, "b.txt"), kind: "file", hidden: false },
            { name: "sub", path: join(root, "sub"), kind: "folder", hidden: false },
        ]);
    });

    test("gives the hidden entries to visit when asked", async () => {
        seed();
        const hiddenSeen: string[] = [];
        (
            await scanFolder(root, true, (entry) => {
                if (entry.hidden) hiddenSeen.push(entry.name);
            })
        )._unsafeUnwrap();
        expect(hiddenSeen).toEqual([".env"]);
    });

    test("counts a link to a folder as an entry of the type symlink", async () => {
        mkdirSync(join(root, "d"));
        symlinkSync("d", join(root, "l"));
        const types: string[] = [];
        (await scanFolder(root, false, (entry) => types.push(`${entry.name}:${entry.kind}`)))._unsafeUnwrap();
        expect(types.sort()).toEqual(["d:folder", "l:symlink"]);
    });

    test("counts the entries of a folder reached through a link", async () => {
        mkdirSync(join(root, "d"));
        writeFileSync(join(root, "d", "f.txt"), "x");
        symlinkSync("d", join(root, "l"));
        expect((await countFolderEntries(join(root, "l"), false))._unsafeUnwrap()).toBe(1);
    });

    test("gives `absent` for a path that does not exist", async () => {
        const missing = join(root, "missing");
        const error = (await countFolderEntries(missing, false))._unsafeUnwrapErr();
        expect(error).toMatchObject({ type: "absent", path: missing });
        expect(error.cause).toMatchObject({ code: "ENOENT" });
    });

    test("gives `not_folder` for a file", async () => {
        const file = join(root, "f.txt");
        writeFileSync(file, "x");
        const error = (await countFolderEntries(file, false))._unsafeUnwrapErr();
        expect(error).toMatchObject({ type: "not_folder", path: file });
        expect(error.cause).toMatchObject({ code: "ENOTDIR" });
    });

    test.skipIf(process.getuid?.() === 0)("gives `unreadable` for a folder with mode 000", async () => {
        const locked = join(root, "locked");
        mkdirSync(locked);
        chmodSync(locked, 0o000);
        try {
            const error = (await countFolderEntries(locked, false))._unsafeUnwrapErr();
            expect(error).toMatchObject({ type: "unreadable", path: locked });
            expect(error.cause).toMatchObject({ code: "EACCES" });
        } finally {
            chmodSync(locked, 0o755);
        }
    });
});

describe("entryDetails", () => {
    const identity = processIdentity();

    async function details(name: string, hidden = false): ReturnType<typeof entryDetails> {
        const folder = (await read(root, hidden))._unsafeUnwrap();
        return entryDetails(entryNamed(folder.entries, name), identity);
    }

    test("gives the facts of a file", async () => {
        writeFileSync(join(root, "f.txt"), "hello");
        chmodSync(join(root, "f.txt"), 0o640);
        const facts = await details("f.txt");
        expect(facts).toMatchObject({ size: 5, link: null });
        expect(facts.modifiedMs).toBeGreaterThan(0);
        expect(facts.mode).toBe(0o640);
        expect(facts.readable).toBe(true);
        expect(facts.writable).toBe(true);
    });

    test("gives a null size for a folder", async () => {
        mkdirSync(join(root, "d"));
        expect(await details("d")).toMatchObject({ size: null, link: null });
        expect((await details("d")).modifiedMs).not.toBeNull();
    });

    test("gives the stored target and the kind of the target for a link to a folder", async () => {
        mkdirSync(join(root, "d"));
        symlinkSync("d", join(root, "l"));
        expect(await details("l")).toMatchObject({ size: null, link: { target: "d", broken: false, targetKind: "folder" } });
    });

    test("describes the target of a link to a file", async () => {
        writeFileSync(join(root, "f.txt"), "abc");
        symlinkSync("f.txt", join(root, "l"));
        expect(await details("l")).toMatchObject({ size: 3, link: { target: "f.txt", broken: false, targetKind: "file" } });
    });

    test("marks a broken link and gives null facts", async () => {
        symlinkSync(join(root, "gone"), join(root, "l"));
        expect(await details("l")).toEqual({
            size: null,
            modifiedMs: null,
            mode: null,
            readable: null,
            writable: null,
            link: { target: join(root, "gone"), broken: true, targetKind: null },
        });
    });

    test("marks a loop of links as broken", async () => {
        symlinkSync("b", join(root, "a"));
        symlinkSync("a", join(root, "b"));
        expect((await details("a")).link).toEqual({ target: "b", broken: true, targetKind: null });
    });

    test("gives null facts for an entry that disappears before its stat", async () => {
        writeFileSync(join(root, "f.txt"), "x");
        const folder = (await read(root))._unsafeUnwrap();
        rmSync(join(root, "f.txt"));
        expect(await entryDetails(entryNamed(folder.entries, "f.txt"), identity)).toEqual({
            size: null,
            modifiedMs: null,
            mode: null,
            readable: null,
            writable: null,
            link: null,
        });
    });

    test("gives null for mode, readable, and writable without a process identity", async () => {
        writeFileSync(join(root, "f.txt"), "x");
        const folder = (await read(root))._unsafeUnwrap();
        const facts = await entryDetails(entryNamed(folder.entries, "f.txt"), null);
        expect(facts).toMatchObject({ size: 1, mode: null, readable: null, writable: null });
        expect(facts.modifiedMs).not.toBeNull();
    });
});
