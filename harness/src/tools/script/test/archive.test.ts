import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";

import { zipSync } from "fflate";

import { archiveKindOf, listArchive, readArchiveEntry } from "../archive.js";

/** One tar header block for a regular file, with the checksum that a reader does not check. */
function tarHeader(name: string, size: number, type = "0"): Buffer {
    const header = Buffer.alloc(512);
    header.write(name.slice(0, 100), 0, "utf8");
    header.write(size.toString(8).padStart(11, "0"), 124, "ascii");
    header.write(type, 156, "ascii");
    header.write("ustar", 257, "ascii");
    return header;
}

function padded(data: Buffer): Buffer {
    return Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

/** A tar of the files, with a GNU long-name entry for a name over 100 bytes. */
function tarOf(files: Record<string, string>): Buffer {
    const blocks: Buffer[] = [];
    for (const [name, text] of Object.entries(files)) {
        const data = Buffer.from(text);
        if (name.length > 100) {
            const longName = Buffer.from(`${name}\0`);
            blocks.push(tarHeader("././@LongLink", longName.length, "L"), padded(longName));
        }
        blocks.push(tarHeader(name, data.length), padded(data));
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
}

describe("archiveKindOf", () => {
    test("names each kind by its extension, and nothing for another file", () => {
        expect(["a.zip", "a.tar", "a.tar.gz", "a.TGZ", "a.csv.gz", "a.csv"].map(archiveKindOf)).toEqual([
            "zip",
            "tar",
            "tar-gzip",
            "tar-gzip",
            "gzip",
            undefined,
        ]);
    });
});

describe("a tar", () => {
    const longName = `${"deep/".repeat(25)}counts.csv`;
    const tar = tarOf({ "GSE1/meta.tsv": "a\tb\n1\t2\n", [longName]: "gene,n\nTP53,4\n" });

    test("lists each regular file, also one with a long name, and reads one", () => {
        expect(listArchive("tar", "x.tar", tar)._unsafeUnwrap()).toEqual([
            { name: "GSE1/meta.tsv", bytes: 8 },
            { name: longName, bytes: 14 },
        ]);
        expect(readArchiveEntry("tar", "x.tar", tar, longName, 1024)._unsafeUnwrap().toString()).toBe("gene,n\nTP53,4\n");
    });

    test("a tar.gz reads the same, and an entry over the cap or absent is refused", () => {
        const gz = gzipSync(tar);
        expect(readArchiveEntry("tar-gzip", "x.tgz", gz, "GSE1/meta.tsv", 1024)._unsafeUnwrap().toString()).toBe("a\tb\n1\t2\n");
        expect(readArchiveEntry("tar-gzip", "x.tgz", gz, "GSE1/meta.tsv", 4)._unsafeUnwrapErr()).toEqual({ kind: "too_large", bytes: 8 });
        expect(readArchiveEntry("tar-gzip", "x.tgz", gz, "none.csv", 1024)._unsafeUnwrapErr()).toEqual({ kind: "not_found" });
    });
});

describe("a zip", () => {
    const zip = Buffer.from(zipSync({ "GSE1/counts.csv": Buffer.from("gene,n\nTP53,4\n"), "GSE1/": new Uint8Array() }));

    test("lists its files from the index, with no directory, and reads one", () => {
        expect(listArchive("zip", "x.zip", zip)._unsafeUnwrap()).toEqual([{ name: "GSE1/counts.csv", bytes: 14 }]);
        expect(readArchiveEntry("zip", "x.zip", zip, "GSE1/counts.csv", 1024)._unsafeUnwrap().toString()).toBe("gene,n\nTP53,4\n");
    });

    test("refuses an entry whose size passes the cap before it decompresses, and a damaged zip", () => {
        expect(readArchiveEntry("zip", "x.zip", zip, "GSE1/counts.csv", 4)._unsafeUnwrapErr()).toEqual({ kind: "too_large", bytes: 14 });
        expect(listArchive("zip", "x.zip", Buffer.from("not a zip"))._unsafeUnwrapErr().kind).toBe("unparsable");
    });
});

describe("a gzip-compressed file", () => {
    const gz = gzipSync(Buffer.from("gene,n\nTP53,4\n"));

    test("is one entry under its name with no .gz, and a read past the cap is refused", () => {
        expect(listArchive("gzip", "runs/counts.csv.gz", gz)._unsafeUnwrap()).toEqual([{ name: "counts.csv", bytes: 14 }]);
        expect(readArchiveEntry("gzip", "runs/counts.csv.gz", gz, "counts.csv", 1024)._unsafeUnwrap().toString()).toBe("gene,n\nTP53,4\n");
        expect(readArchiveEntry("gzip", "runs/counts.csv.gz", gz, "counts.csv", 4)._unsafeUnwrapErr()).toEqual({ kind: "too_large", bytes: undefined });
    });
});
