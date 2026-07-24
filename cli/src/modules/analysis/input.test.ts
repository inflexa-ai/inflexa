import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { AnalysisInput } from "../../types/analysis.ts";
import { classifyInputPath, expandAndResolve, matchInputRefs } from "./input.ts";
import { canonicalPath, writeMarker } from "../anchor/marker.ts";

const created: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "inflexa-input-"));
    created.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
});

describe("classifyInputPath", () => {
    test("inside a tracked anchor → an anchor-relative ref that rides the anchor's UUID", () => {
        const dir = tmp();
        writeMarker(dir, "A1")._unsafeUnwrap();
        mkdirSync(join(dir, "src"));
        const ref = classifyInputPath("ana1", "src", dir)._unsafeUnwrap();
        expect(ref).toEqual({ path: "src", isDir: true, analysisId: "ana1", anchorId: "A1" });
    });

    test("at the anchor directory itself → relative path '.'", () => {
        const dir = tmp();
        writeMarker(dir, "A1")._unsafeUnwrap();
        const ref = classifyInputPath("ana1", ".", dir)._unsafeUnwrap();
        expect(ref.path).toBe(".");
        expect(ref.anchorId).toBe("A1");
    });

    test("not under any anchor → an absolute ref with no anchor", () => {
        const dir = tmp(); // no marker anywhere upward
        mkdirSync(join(dir, "src"));
        const ref = classifyInputPath("ana1", "src", dir)._unsafeUnwrap();
        expect(ref.anchorId).toBeNull();
        expect(ref.path).toBe(canonicalPath(join(dir, "src")));
    });

    test("a non-existent path → error, never stored as a dangling ref", () => {
        const dir = tmp();
        classifyInputPath("ana1", "ghost", dir).match(
            () => {
                throw new Error("expected an error for a missing path");
            },
            (e) => expect(e.type).toBe("query_failed"),
        );
    });
});

describe("expandAndResolve", () => {
    test("expands a leading ~ to the home directory", () => {
        expect(expandAndResolve("/anywhere", "~/data/x.csv")).toBe(join(homedir(), "data/x.csv"));
    });

    test("resolves a relative path against cwd", () => {
        expect(expandAndResolve(join("/root", "proj"), "sub/x.csv")).toBe(join("/root", "proj", "sub/x.csv"));
    });

    test("leaves an absolute path unchanged", () => {
        const abs = join("/data", "x.csv");
        expect(expandAndResolve("/root/proj", abs)).toBe(abs);
    });
});

describe("matchInputRefs", () => {
    // Anchorless inputs resolve to their own absolute path without touching the DB, so these are pure.
    function absInput(path: string): AnalysisInput {
        return { path, isDir: false, analysisId: "ana1", anchorId: null };
    }

    test("matches a raw path by an input's stored ref", () => {
        const foo = absInput(join("/data", "foo.csv"));
        const bar = absInput(join("/data", "bar.csv"));
        const { matched, notInputs } = matchInputRefs([foo, bar], [join("/data", "foo.csv")], "/cwd");
        expect(matched).toEqual([foo]);
        expect(notInputs).toEqual([]);
    });

    test("matches an anchorless input by cwd-resolved path", () => {
        const foo = absInput(join("/proj", "foo.csv"));
        const { matched, notInputs } = matchInputRefs([foo], ["foo.csv"], "/proj");
        expect(matched).toEqual([foo]);
        expect(notInputs).toEqual([]);
    });

    test("a path that is no current input is reported, never matched", () => {
        const foo = absInput(join("/data", "foo.csv"));
        const { matched, notInputs } = matchInputRefs([foo], [join("/data", "ghost.csv")], "/cwd");
        expect(matched).toEqual([]);
        expect(notInputs).toEqual([join("/data", "ghost.csv")]);
    });

    test("matches without any on-disk check — an input whose file is gone stays removable", () => {
        // A path under a tmp dir that never existed: matchInputRefs must still match it by ref alone.
        const goneAbs = join(tmpdir(), "inflexa-never-existed", "deleted.csv");
        expect(isAbsolute(goneAbs)).toBe(true);
        const gone = absInput(goneAbs);
        const { matched } = matchInputRefs([gone], [goneAbs], "/cwd");
        expect(matched).toEqual([gone]);
    });
});
