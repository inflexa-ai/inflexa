import { describe, expect, it } from "bun:test";
import { gzipSync, zstdCompressSync } from "node:zlib";

import { READOUT_TEXT_BYTES, readPrefix } from "./readout.js";

const VCF = [
    "##fileformat=VCFv4.3",
    "##reference=file:///refs/synthetic.fa",
    "##contig=<ID=chr1,length=1000>",
    '##INFO=<ID=DP,Number=1,Type=Integer,Description="Depth">',
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tS1\tS2\tS3",
    "chr1\t100\t.\tA\tG\t50\tPASS\tDP=10\tGT\t0/1\t0/0\t1/1",
].join("\n");

function prefix(text: string): Buffer {
    return Buffer.from(text, "utf8");
}

describe("readPrefix — delimited text", () => {
    it("sniffs the delimiter, the header row, and the column names", async () => {
        const readout = await readPrefix({ prefix: prefix("gene,sample,count\nTP53,S1,4\nEGFR,S1,9\n"), format: "csv" });
        expect(readout.fields).toEqual({
            delimiter: "comma",
            columnCount: 3,
            columns: "gene, sample, count",
            headerRow: true,
            linesInPrefix: 3,
        });
    });

    it("reads a tab-separated file and honours quoted cells", async () => {
        const readout = await readPrefix({ prefix: prefix('"gene name"\tvalue\n"a,b"\t1\n'), format: "tsv" });
        expect(readout.fields.delimiter).toBe("tab");
        expect(readout.fields.columns).toBe("gene name, value");
    });

    it("finds the header past a comment preamble and counts the comments", async () => {
        const readout = await readPrefix({ prefix: prefix("# generated\n# by nothing real\nid;value\n1;2\n"), format: "csv" });
        expect(readout.fields.delimiter).toBe("semicolon");
        expect(readout.fields.commentLines).toBe(2);
        expect(readout.fields.columns).toBe("id, value");
    });

    it("calls a row of numbers data, not column names", async () => {
        const readout = await readPrefix({ prefix: prefix("1,2,3\n4,5,6\n"), format: "csv" });
        expect(readout.fields.headerRow).toBe(false);
    });
});

describe("readPrefix — declared text headers", () => {
    it("reads a VCF preamble and its sample columns", async () => {
        const readout = await readPrefix({ prefix: prefix(VCF), format: "vcf" });
        expect(readout.fields.fileformat).toBe("VCFv4.3");
        expect(readout.fields.reference).toBe("file:///refs/synthetic.fa");
        expect(readout.fields.sampleCount).toBe(3);
        expect(readout.fields.samples).toBe("S1, S2, S3");
        expect(readout.fields.metaLines).toBe(4);
    });

    it("sniffs the data row of a GFF whose preamble names no columns", async () => {
        const gff = "##gff-version 3\n##sequence-region chr1 1 1000\nchr1\tsrc\tgene\t1\t9\t.\t+\t.\tID=g1\n";
        const readout = await readPrefix({ prefix: prefix(gff), format: "gff3" });
        expect(readout.fields.gffVersion).toBe("3");
        expect(readout.fields.metaLines).toBe(2);
        expect(readout.fields.columnCount).toBe(9);
    });

    it("reads a SAM header", async () => {
        const sam = "@HD\tVN:1.6\tSO:coordinate\n@SQ\tSN:chr1\tLN:1000\n@SQ\tSN:chr2\tLN:900\n@RG\tID:rg1\n";
        const readout = await readPrefix({ prefix: prefix(sam), format: "sam" });
        expect(readout.fields).toEqual({ referenceSequences: 2, readGroups: 1, sortOrder: "coordinate" });
    });

    it("reads FASTA records", async () => {
        const readout = await readPrefix({ prefix: prefix(">seq1 first\nACGT\n>seq2\nTTTT\n"), format: "fasta" });
        expect(readout.fields).toEqual({ firstRecord: "seq1 first", recordsInPrefix: 2 });
    });

    it("reads a FASTQ record length", async () => {
        const readout = await readPrefix({ prefix: prefix("@read1\nACGTACGT\n+\nIIIIIIII\n"), format: "fastq" });
        expect(readout.fields).toEqual({ firstRecord: "read1", readLength: 8 });
    });

    it("falls back to the first line for unstructured text", async () => {
        const readout = await readPrefix({ prefix: prefix("a plain note\nwith no structure\n"), format: "text" });
        expect(readout.fields).toEqual({ firstLine: "a plain note", linesInPrefix: 2 });
    });
});

describe("readPrefix — documents and config", () => {
    it("reads the top-level keys of a JSON object", async () => {
        const readout = await readPrefix({ prefix: prefix('{"study":"s1","samples":[1,2],"notes":null}'), format: "json" });
        expect(readout.fields).toEqual({ jsonType: "object", keyCount: 3, keys: "study, samples, notes" });
    });

    it("reads a JSON array and the keys of its first element", async () => {
        const readout = await readPrefix({ prefix: prefix('[{"id":1,"arm":"a"},{"id":2,"arm":"b"}]'), format: "json" });
        expect(readout.fields).toEqual({ jsonType: "array", elementCount: 2, firstElementKeys: "id, arm" });
    });

    it("recognises JSON Lines whose tail record is cut off", async () => {
        const readout = await readPrefix({ prefix: prefix('{"id":1,"v":2}\n{"id":2,"v":3}\n{"id":3,"v'), format: "json" });
        expect(readout.fields.jsonType).toBe("json-lines");
        expect(readout.fields.keys).toBe("id, v");
    });

    it("says so when a JSON document runs past the prefix", async () => {
        const readout = await readPrefix({ prefix: prefix('{\n  "study": "s1",\n  "samples": [\n    1,'), format: "json" });
        expect(readout.unavailable).toBe("JSON document extends past the readout prefix");
    });

    it("reads unindented YAML keys and its document separators", async () => {
        const yaml = "---\nname: study\nversion: 2\nsteps:\n  - one\n  - two\n---\nname: second\n";
        const readout = await readPrefix({ prefix: prefix(yaml), format: "yaml" });
        expect(readout.fields.topLevelKeys).toBe("name, version, steps, name");
        expect(readout.fields.topLevelKeyCount).toBe(4);
        expect(readout.fields.documentSeparators).toBe(2);
    });

    it("reads a Markdown title and heading count", async () => {
        const readout = await readPrefix({ prefix: prefix("# Study notes\n\nsome prose\n\n## Methods\n"), format: "markdown" });
        expect(readout.fields).toEqual({ title: "Study notes", headings: 2, linesInPrefix: 3 });
    });
});

describe("readPrefix — compressed prefixes", () => {
    it("reads the header of a gzip-wrapped VCF and reports the wrapper alongside it", async () => {
        const readout = await readPrefix({ prefix: gzipSync(Buffer.from(VCF)), format: "vcf", wrapper: "gzip" });
        expect(readout.fields.wrapper).toBe("gzip");
        expect(readout.fields.fileformat).toBe("VCFv4.3");
        expect(readout.fields.sampleCount).toBe(3);
    });

    it("decodes a truncated compressed prefix rather than failing on it", async () => {
        const body = Array.from({ length: 4000 }, (_, i) => `chr1\t${i}\t.\tA\tG`).join("\n");
        const full = gzipSync(Buffer.from(`${VCF}\n${body}`));
        const readout = await readPrefix({ prefix: full.subarray(0, Math.floor(full.length / 2)), format: "vcf", wrapper: "bgzip" });
        expect(readout.fields.wrapper).toBe("bgzip");
        expect(readout.fields.fileformat).toBe("VCFv4.3");
    });

    it("bounds what a compressed prefix may expand to", async () => {
        const readout = await readPrefix({ prefix: gzipSync(Buffer.alloc(4 * READOUT_TEXT_BYTES, "x")), format: "text", wrapper: "gzip" });
        expect(String(readout.fields.firstLine).length).toBeLessThanOrEqual(120);
    });

    it("reads a zstd-wrapped table whose frame fits the prefix", async () => {
        const readout = await readPrefix({ prefix: zstdCompressSync(Buffer.from("gene,count\nTP53,4\n")), format: "csv", wrapper: "zstd" });
        expect(readout.fields.wrapper).toBe("zstd");
        expect(readout.fields.columns).toBe("gene, count");
    });

    it("names the wrapper it cannot decode in process", async () => {
        const readout = await readPrefix({ prefix: Buffer.from("BZh91AY&SY"), format: "csv", wrapper: "bzip2" });
        expect(readout.fields).toEqual({ wrapper: "bzip2" });
        expect(readout.unavailable).toBe("bzip2 has no in-process prefix decoder");
    });

    it("reads a BAM header out of its gzip member", async () => {
        const header = "@HD\tVN:1.6\tSO:coordinate\n@SQ\tSN:chr1\tLN:1000\n";
        const text = Buffer.from(header, "utf8");
        const bam = Buffer.concat([Buffer.from("BAM\u0001", "latin1"), int32(text.length), text]);
        const readout = await readPrefix({ prefix: gzipSync(bam), format: "bam", wrapper: "bgzip" });
        expect(readout.fields.container).toBe("bam");
        expect(readout.fields.referenceSequences).toBe(1);
        expect(readout.fields.wrapper).toBe("bgzip");
    });

    it("names a BCF container", async () => {
        const bcf = Buffer.concat([Buffer.from("BCF", "latin1"), Buffer.alloc(16)]);
        const readout = await readPrefix({ prefix: gzipSync(bcf), format: "bcf", wrapper: "bgzip" });
        expect(readout.fields).toEqual({ container: "bcf", wrapper: "bgzip" });
    });
});

describe("readPrefix — what a prefix cannot say", () => {
    it("reports an empty file rather than an empty readout", async () => {
        expect(await readPrefix({ prefix: Buffer.alloc(0), format: "csv" })).toEqual({ fields: {}, unavailable: "file is empty" });
    });

    it("refuses to render binary bytes as a header line", async () => {
        const readout = await readPrefix({ prefix: Buffer.from([0x50, 0x41, 0x52, 0x31, 0x00, 0x01, 0x02, 0x03]), format: "parquet" });
        expect(readout).toEqual({ fields: {}, unavailable: "binary content with no prefix-readable header" });
    });
});

function int32(value: number): Buffer {
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(value, 0);
    return buf;
}
