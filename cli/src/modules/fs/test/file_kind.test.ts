import { describe, expect, test } from "bun:test";

import { SPEC_FILE_TYPES } from "../../../test_support/file_types.ts";
import { fileKindOf, languageOf } from "../file_kind.ts";

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
        for (const name of ["README", "draft.", ""]) {
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

    test("give code to a script of run_script, and doc to a text note", () => {
        expect([fileKindOf("call_1.js"), languageOf("call_1.js")]).toEqual(["code", "javascript"]);
        expect([fileKindOf("plot.tsx"), languageOf("plot.tsx")]).toEqual(["code", "tsx"]);
        expect([fileKindOf("README.txt"), languageOf("README.txt")]).toEqual(["doc", "text"]);
    });

    test("give the shiki id and the kind of a language that only Linguist knows", () => {
        expect([fileKindOf("build.kts"), languageOf("build.kts")]).toEqual(["code", "kotlin"]);
        expect([fileKindOf("main.swift"), languageOf("main.swift")]).toEqual(["code", "swift"]);
        expect([fileKindOf("Gemfile"), languageOf("Gemfile")]).toEqual(["code", "ruby"]);
    });

    test("give the kind of the Linguist type", () => {
        expect([fileKindOf("App.vue"), languageOf("App.vue")]).toEqual(["code", "vue"]);
        expect([fileKindOf("de.po"), languageOf("de.po")]).toEqual(["doc", "po"]);
        expect([fileKindOf("api.proto"), languageOf("api.proto")]).toEqual(["data", "proto"]);
    });

    test("read the table only for the extension before .gz", () => {
        expect([fileKindOf("main.swift.gz"), languageOf("main.swift.gz")]).toEqual(["data", "text"]);
    });

    test("give the canonical shiki id for a Linguist file name", () => {
        expect([fileKindOf(".bashrc"), languageOf(".bashrc")]).toEqual(["code", "shellscript"]);
        expect(languageOf("/home/u/.BASHRC")).toBe("shellscript");
    });

    test("let a Linguist file name win over the extension in the table", () => {
        expect([fileKindOf("CMakeLists.txt"), languageOf("CMakeLists.txt")]).toEqual(["code", "cmake"]);
    });

    test("give no shiki id to a Linguist language whose alias names a different grammar", () => {
        expect([fileKindOf("query.cql"), languageOf("query.cql")]).toEqual([null, "text"]);
        expect(languageOf("page.ftlh")).toBe("text");
        expect(languageOf("messages.ftl")).toBe("fluent");
    });

    test("let the table win over Linguist for an extension", () => {
        expect(languageOf("fit.m")).toBe("matlab");
        expect(languageOf("run.do")).toBe("stata");
    });

    test("give an extension of more than one Linguist language to the language whose primary extension it is", () => {
        expect(languageOf("site.pp")).toBe("puppet");
    });

    test("does not read an inherited property of the map as a kind", () => {
        expect(fileKindOf("x.constructor")).toBeNull();
        expect(fileKindOf("x.__proto__")).toBeNull();
        expect(languageOf("constructor")).toBe("text");
    });
});
