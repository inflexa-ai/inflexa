import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyInputPath } from "./input.ts";
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
