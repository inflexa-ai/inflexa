import { describe, expect, test } from "bun:test";

import { SPEC_FILE_TYPES } from "../../test_support/file_types.ts";
import { fileKindOf, languageOf } from "./file_kind.ts";

describe("fileKindOf and languageOf", () => {
    for (const [name, kind, language] of SPEC_FILE_TYPES) {
        test(`give ${kind} and ${language} for ${name}`, () => {
            expect(fileKindOf(name)).toBe(kind);
            expect(languageOf(name)).toBe(language);
        });
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

    test("give the language text for a .gz file, also when the inner extension has a language", () => {
        expect(languageOf("analysis.py.gz")).toBe("text");
        expect(languageOf("counts.csv.gz")).toBe("text");
    });

    test("give null and text for an unknown extension", () => {
        expect(fileKindOf("notes.xyz")).toBeNull();
        expect(languageOf("notes.xyz")).toBe("text");
    });

    test("give null and text for a name with no extension and no name entry", () => {
        for (const name of ["README", ".bashrc", "draft.", ""]) {
            expect(fileKindOf(name)).toBeNull();
            expect(languageOf(name)).toBe("text");
        }
    });

    test("match a name entry with no regard to case, and only the whole name", () => {
        expect(fileKindOf("SNAKEFILE")).toBe("code");
        expect(languageOf("dockerfile")).toBe("docker");
        expect(languageOf("Nextflow.Config")).toBe("nextflow");
        expect(fileKindOf("my.snakefile")).toBeNull();
        expect(fileKindOf("Dockerfile.dev")).toBeNull();
    });

    test("do not read a whole name as an extension key", () => {
        expect(fileKindOf("R")).toBeNull();
        expect(fileKindOf("json")).toBeNull();
    });

    test("reads the last part of a path, so a dot in a folder name does not count", () => {
        expect(fileKindOf("/data/v1.2/README")).toBeNull();
        expect(languageOf("/data/v1.2/Makefile")).toBe("make");
        expect(fileKindOf("/data/study.csv/README")).toBeNull();
        expect(fileKindOf("/data/study.log/counts.csv")).toBe("table");
        expect(fileKindOf("/data/study.csv/counts.csv.gz")).toBe("table");
        expect(fileKindOf("C:\\data\\v1.2\\README")).toBeNull();
        expect(fileKindOf("C:\\data\\v1.2\\counts.csv")).toBe("table");
    });

    test("does not read an inherited property of the map as a kind", () => {
        expect(fileKindOf("x.constructor")).toBeNull();
        expect(fileKindOf("x.__proto__")).toBeNull();
        expect(languageOf("constructor")).toBe("text");
    });
});
