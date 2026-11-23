import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";

import { zipSync } from "fflate";

import { archiveKindOf, extractTarStream, extractZipStream, listArchive, readArchiveEntry } from "../archive.js";

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

describe("a streamed extraction", () => {
    function chunks(data: Buffer, size = 700): Readable {
        const pieces: Buffer[] = [];
        for (let offset = 0; offset < data.length; offset += size) pieces.push(data.subarray(offset, offset + size));
        return Readable.from(pieces);
    }

    let dest = "";
    beforeEach(async () => {
        dest = await mkdtemp(join(tmpdir(), "extract-"));
    });
    afterEach(async () => {
        await rm(dest, { recursive: true, force: true });
    });

    test("a tar writes each file, also one with a long name, and skips a link", async () => {
        const longName = `${"deep/".repeat(25)}counts.csv`;
        const tar = tarOf({ "GSE1/meta.tsv": "a\tb\n", [longName]: "gene,n\n" });
        const withLink = Buffer.concat([tarHeader("GSE1/link", 0, "2"), tar]);
        const summary = (await extractTarStream(chunks(withLink), dest))._unsafeUnwrap();
        expect(summary).toEqual({ files: 2, directories: 0, skippedLinks: 1 });
        expect(await readFile(join(dest, "GSE1/meta.tsv"), "utf8")).toBe("a\tb\n");
        expect(await readFile(join(dest, longName), "utf8")).toBe("gene,n\n");
        expect(await readdir(join(dest, "GSE1"))).toEqual(["meta.tsv"]);
    });

    test("a tar entry that leaves the directory stops the extraction, and writes nothing outside", async () => {
        const inner = join(dest, "inner");
        await mkdir(inner);
        const refusal = (await extractTarStream(chunks(tarOf({ "../../escape.txt": "x" })), inner))._unsafeUnwrapErr();
        expect(refusal).toEqual({ kind: "unsafe_entry", entry: "../../escape.txt" });
        expect(await readdir(dest)).toEqual(["inner"]);
        expect((await extractTarStream(chunks(tarOf({ "/etc/x": "x" })), inner))._unsafeUnwrapErr()).toEqual({ kind: "unsafe_entry", entry: "/etc/x" });
    });

    test("a tar that ends inside an entry is unparsable", async () => {
        const tar = tarOf({ "a.txt": "x".repeat(2000) });
        const refusal = (await extractTarStream(chunks(tar.subarray(0, 1024)), dest))._unsafeUnwrapErr();
        expect(refusal.kind).toBe("unparsable");
    });

    test("a zip writes each file and directory", async () => {
        const zip = Buffer.from(zipSync({ "set/": {}, "set/a.gmt": new TextEncoder().encode("HALLMARK_X\tna\tTP53\n".repeat(500)) }));
        const summary = (await extractZipStream(chunks(zip), dest))._unsafeUnwrap();
        expect(summary.files).toBe(1);
        expect(await readFile(join(dest, "set/a.gmt"), "utf8")).toBe("HALLMARK_X\tna\tTP53\n".repeat(500));
    });

    test("a zip entry that leaves the directory stops the extraction", async () => {
        const zip = Buffer.from(zipSync({ "../x.txt": new TextEncoder().encode("x") }));
        expect((await extractZipStream(chunks(zip), dest))._unsafeUnwrapErr()).toEqual({ kind: "unsafe_entry", entry: "../x.txt" });
        expect(await readdir(dest)).toEqual([]);
    });
});
