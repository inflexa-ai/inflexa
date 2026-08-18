import { describe, expect, it } from "bun:test";

import { detectFormat, extensionChain, innerExtensions } from "./formats.js";

const GZIP = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
const BGZIP = Buffer.from([0x1f, 0x8b, 0x08, 0x04, 0, 0, 0, 0, 0, 0, 6, 0, 0x42, 0x43, 2, 0, 0, 0]);
const HDF5 = Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("extensionChain", () => {
    it("keeps the whole chain, outermost last", () => {
        expect(extensionChain("sample.vcf.gz")).toEqual(["vcf", "gz"]);
        expect(extensionChain("counts.csv")).toEqual(["csv"]);
        expect(extensionChain("README")).toEqual([]);
        expect(extensionChain(".hidden")).toEqual([]);
    });

    it("strips compression wrappers on request", () => {
        expect(innerExtensions(["vcf", "gz"])).toEqual(["vcf"]);
        expect(innerExtensions(["fastq", "bgz"])).toEqual(["fastq"]);
        expect(innerExtensions(["csv"])).toEqual(["csv"]);
    });
});

describe("detectFormat", () => {
    it("reports a compressed file's inner format with its wrapper", () => {
        expect(detectFormat({ path: "data/inputs/s.vcf.gz", extensions: ["vcf", "gz"], prefix: GZIP })).toEqual({ format: "vcf", wrapper: "gzip" });
        expect(detectFormat({ path: "data/inputs/s.vcf.gz", extensions: ["vcf", "gz"], prefix: BGZIP })).toEqual({ format: "vcf", wrapper: "bgzip" });
    });

    it("never reports the wrapper as the format", () => {
        const detected = detectFormat({ path: "data/inputs/s.bam", extensions: ["bam"], prefix: BGZIP });
        expect(detected.format).toBe("bam");
        expect(detected.format).not.toBe("gzip");
    });

    it("prefers content over extension for an uncompressed file", () => {
        const vcfText = Buffer.from("##fileformat=VCFv4.2\n#CHROM\tPOS\n");
        expect(detectFormat({ path: "data/inputs/mislabelled.txt", extensions: ["txt"], prefix: vcfText }).format).toBe("vcf");
    });

    it("specialises a container by extension where the magic is generic", () => {
        expect(detectFormat({ path: "data/inputs/a.h5ad", extensions: ["h5ad"], prefix: HDF5 }).format).toBe("h5ad");
        expect(detectFormat({ path: "data/inputs/a.loom", extensions: ["loom"], prefix: HDF5 }).format).toBe("loom");
        expect(detectFormat({ path: "data/inputs/a.h5", extensions: ["h5"], prefix: HDF5 }).format).toBe("hdf5");
    });

    it("tells PLINK's binary .bed from an interval .bed by its magic", () => {
        const plink = Buffer.from([0x6c, 0x1b, 0x01, 0x00]);
        const intervals = Buffer.from("chr1\t100\t200\tfeature\n");
        expect(detectFormat({ path: "g.bed", extensions: ["bed"], prefix: plink }).format).toBe("plink-bed");
        expect(detectFormat({ path: "r.bed", extensions: ["bed"], prefix: intervals }).format).toBe("bed");
    });

    it("reports an unrecognised format as unknown, extension chain intact", () => {
        const detected = detectFormat({ path: "data/inputs/x.qqq", extensions: ["qqq"], prefix: Buffer.from([0x00, 0x01, 0x02]) });
        expect(detected.format).toBe("unknown");
        expect(detected.wrapper).toBeUndefined();
    });

    it("treats every member of a .zarr store as one format", () => {
        expect(detectFormat({ path: "data/inputs/x.zarr/0/0/0", extensions: [], prefix: null }).format).toBe("zarr");
    });
});
