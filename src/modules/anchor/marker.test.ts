import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findMarkerUpwards, markerPath, readMarker, writeMarker } from "./marker.ts";

const created: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "inflexa-marker-"));
    created.push(dir);
    return dir;
}

function writeRawMarker(dir: string, content: string): void {
    mkdirSync(join(dir, ".inflexa"), { recursive: true });
    writeFileSync(join(dir, ".inflexa", "id"), content);
}

afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
});

describe("readMarker", () => {
    test("returns null when there is no marker (the normal not-an-anchor case)", () => {
        expect(readMarker(tmp())).toBeNull();
    });

    test("returns the marker when present and valid", () => {
        const dir = tmp();
        writeMarker(dir, "anchor-1");
        expect(readMarker(dir)).toEqual({ schemaVersion: 1, anchorId: "anchor-1" });
    });

    test("throws on a present-but-corrupt marker (malformed JSON) — never silently re-minted", () => {
        const dir = tmp();
        writeRawMarker(dir, "{ not json");
        expect(() => readMarker(dir)).toThrow();
    });

    test("throws on a marker that fails the schema (wrong schemaVersion)", () => {
        const dir = tmp();
        writeRawMarker(dir, JSON.stringify({ schemaVersion: 2, anchorId: "x" }));
        expect(() => readMarker(dir)).toThrow();
    });
});

describe("writeMarker", () => {
    test("creates the marker file when absent", () => {
        const dir = tmp();
        const marker = writeMarker(dir, "anchor-1");
        expect(marker).toEqual({ schemaVersion: 1, anchorId: "anchor-1" });
        expect(existsSync(markerPath(dir))).toBe(true);
    });

    test("is write-once: an existing marker's UUID wins and the file is not rewritten", () => {
        const dir = tmp();
        writeMarker(dir, "first-uuid");
        const result = writeMarker(dir, "second-uuid");
        expect(result.anchorId).toBe("first-uuid");
    });

    test("throws on a corrupt existing marker rather than clobbering it", () => {
        const dir = tmp();
        writeRawMarker(dir, "{ not json");
        expect(() => writeMarker(dir, "anchor-1")).toThrow();
    });
});

describe("findMarkerUpwards", () => {
    test("finds a marker in the start directory itself", () => {
        const dir = tmp();
        writeMarker(dir, "anchor-1");
        const found = findMarkerUpwards(dir);
        expect(found?.dir).toBe(dir);
        expect(found?.marker.anchorId).toBe("anchor-1");
    });

    test("walks up to the nearest ancestor that holds a marker", () => {
        const dir = tmp();
        writeMarker(dir, "anchor-1");
        const deep = join(dir, "a", "b", "c");
        mkdirSync(deep, { recursive: true });
        const found = findMarkerUpwards(deep);
        expect(found?.dir).toBe(dir);
        expect(found?.marker.anchorId).toBe("anchor-1");
    });

    test("returns null when no ancestor holds a marker", () => {
        expect(findMarkerUpwards(tmp())).toBeNull();
    });
});
