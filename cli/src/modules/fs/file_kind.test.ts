import { describe, expect, test } from "bun:test";

import type { FileKind } from "../../api/fs.ts";
import { fileKindOf } from "./file_kind.ts";

const EXTENSIONS: Record<FileKind, readonly string[]> = {
    table: ["csv", "tsv", "txt", "xlsx", "parquet"],
    figure: ["png", "svg", "jpg"],
    code: ["py", "r", "ipynb", "toml", "sh"],
    log: ["log"],
    data: ["json", "h5ad", "gz", "bam"],
    doc: ["md", "docx", "pdf"],
};

describe("fileKindOf", () => {
    for (const [kind, extensions] of Object.entries(EXTENSIONS)) {
        for (const extension of extensions) {
            test(`gives ${kind} for .${extension}`, () => {
                expect(fileKindOf(`sample.${extension}`)).toBe(kind as FileKind);
            });
        }
    }

    test("matches the extension with no regard to case", () => {
        expect(fileKindOf("counts.csv")).toBe("table");
        expect(fileKindOf("Counts.CSV")).toBe("table");
        expect(fileKindOf("analysis.R")).toBe("code");
    });

    test("gives the kind of the extension before .gz when the map knows it", () => {
        expect(fileKindOf("counts.csv.gz")).toBe("table");
        expect(fileKindOf("COUNTS.CSV.GZ")).toBe("table");
        expect(fileKindOf("plot.png.gz")).toBe("figure");
    });

    test("gives data for a .gz file whose inner extension is unknown or absent", () => {
        expect(fileKindOf("reads.gz")).toBe("data");
        expect(fileKindOf("archive.tar.gz")).toBe("data");
        expect(fileKindOf(".csv.gz")).toBe("data");
        expect(fileKindOf("trailing..gz")).toBe("data");
    });

    test("gives null for an unknown extension", () => {
        expect(fileKindOf("notes.xyz")).toBeNull();
    });

    test("gives null for a name with no extension", () => {
        expect(fileKindOf("Makefile")).toBeNull();
        expect(fileKindOf(".bashrc")).toBeNull();
        expect(fileKindOf("draft.")).toBeNull();
        expect(fileKindOf("")).toBeNull();
    });

    test("reads the last part of a path, so a dot in a folder name does not count", () => {
        expect(fileKindOf("/data/v1.2/Makefile")).toBeNull();
        expect(fileKindOf("/data/study.csv/README")).toBeNull();
        expect(fileKindOf("/data/study.log/counts.csv")).toBe("table");
        expect(fileKindOf("/data/study.csv/counts.csv.gz")).toBe("table");
        expect(fileKindOf("C:\\data\\v1.2\\Makefile")).toBeNull();
        expect(fileKindOf("C:\\data\\v1.2\\counts.csv")).toBe("table");
    });

    test("does not read an inherited property of the map as a kind", () => {
        expect(fileKindOf("x.constructor")).toBeNull();
        expect(fileKindOf("x.__proto__")).toBeNull();
    });
});
