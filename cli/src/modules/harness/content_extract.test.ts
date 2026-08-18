import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { contentHashOf, packContent, type PackEntry } from "./content-pack.ts";
import { extractContent } from "./content_extract.ts";

const FILES: PackEntry[] = [
    { path: "skills/report-html/SKILL.md", bytes: Buffer.from("# Report HTML\n", "utf8") },
    { path: "skills/report-html/references/blocks.md", bytes: Buffer.from("block reference", "utf8") },
    // A font is binary, thus the asset entry carries bytes that are not text.
    { path: "assets/space-grotesk-latin-wght-normal.woff2", bytes: Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff]) },
];

const HASH = contentHashOf(FILES);

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "content-extract-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/**
 * Write the archive into the content directory, and give the path of the archive.
 *
 * The prune removes each sibling of the hash directory that has no `.tmp-` prefix, and the archive file is
 * such a sibling. Thus a case that extracts two times calls this function again.
 */
function writeArchive(): string {
    const path = join(root, "content.pack");
    writeFileSync(path, packContent(FILES));
    return path;
}

describe("extractContent", () => {
    test("a fresh extract writes the two trees with the bytes of the archive", () => {
        const dirs = extractContent({ archivePath: writeArchive(), contentDir: root, contentHash: HASH })._unsafeUnwrap();

        expect(dirs).toEqual({
            skillsDir: join(root, HASH, "skills"),
            assetsDir: join(root, HASH, "assets"),
        });
        for (const dir of [dirs.skillsDir, dirs.assetsDir]) {
            expect(existsSync(dir)).toBe(true);
        }
        for (const file of FILES) {
            expect(readFileSync(join(root, HASH, file.path)).equals(file.bytes)).toBe(true);
        }
    });

    test("a hash directory without the assets tree is not reused, and the extract cannot repair it", () => {
        mkdirSync(join(root, HASH, "skills"), { recursive: true });

        // The partial directory fails the completeness gate, thus the cold path runs, and the error proves
        // that it ran. But `rename` wants a target that is absent or empty, and this target holds one tree.
        // As a result the commit of the extract fails with ENOTEMPTY, and the assets tree stays absent.
        const error = extractContent({ archivePath: writeArchive(), contentDir: root, contentHash: HASH })._unsafeUnwrapErr();

        expect(error).toMatchObject({ type: "unwritable", path: join(root, HASH) });
        expect(existsSync(join(root, HASH, "assets"))).toBe(false);
    });

    test("a complete hash directory is reused, thus no extract runs", () => {
        const first = extractContent({ archivePath: writeArchive(), contentDir: root, contentHash: HASH })._unsafeUnwrap();
        // A file that the archive does not carry proves the reuse. A second extract replaces the whole tree
        // under one rename, thus it removes this file.
        const witness = join(first.skillsDir, "witness.txt");
        writeFileSync(witness, "keep me");

        const second = extractContent({ archivePath: writeArchive(), contentDir: root, contentHash: HASH })._unsafeUnwrap();

        expect(second).toEqual(first);
        expect(readFileSync(witness, "utf8")).toBe("keep me");
    });

    test("an absent content hash gives no_content_hash, and it writes nothing", () => {
        const error = extractContent({ archivePath: join(root, "content.pack"), contentDir: root, contentHash: undefined })._unsafeUnwrapErr();

        expect(error).toEqual({ type: "no_content_hash" });
        expect(readdirSync(root)).toEqual([]);
    });

    test("the extract prunes a stale hash directory, and it spares a .tmp- sibling", () => {
        const stale = join(root, "0123456789abcdef");
        mkdirSync(join(stale, "skills"), { recursive: true });
        // Another process can be in the middle of an extract under its own pid, thus a staging directory
        // survives the prune.
        const staging = join(root, ".tmp-0123456789abcdef-4242");
        mkdirSync(staging, { recursive: true });

        extractContent({ archivePath: writeArchive(), contentDir: root, contentHash: HASH })._unsafeUnwrap();

        expect(existsSync(stale)).toBe(false);
        expect(existsSync(staging)).toBe(true);
    });

    test("an archive path that names no file gives archive_read_failed", () => {
        const error = extractContent({ archivePath: join(root, "absent.pack"), contentDir: root, contentHash: HASH })._unsafeUnwrapErr();

        expect(error.type).toBe("archive_read_failed");
    });
});
