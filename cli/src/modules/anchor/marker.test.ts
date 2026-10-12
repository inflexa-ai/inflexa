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
    test("returns ok(null) when there is no marker (the normal not-an-anchor case)", async () => {
        const result = await readMarker(tmp());
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap()).toBeNull();
    });

    test("returns ok(marker) when present and valid", async () => {
        const dir = tmp();
        (await writeMarker(dir, "anchor-1"))._unsafeUnwrap();
        const result = await readMarker(dir);
        expect(result._unsafeUnwrap()).toEqual({ schemaVersion: 1, anchorId: "anchor-1" });
    });

    test("returns err on a present-but-corrupt marker (malformed JSON) — never silently re-minted", async () => {
        const dir = tmp();
        writeRawMarker(dir, "{ not json");
        (await readMarker(dir)).match(
            () => {
                throw new Error("expected a marker_corrupt error on malformed JSON");
            },
            (e) => {
                expect(e.type).toBe("marker_corrupt");
            },
        );
    });

    test("returns err on a marker that fails the schema (wrong schemaVersion)", async () => {
        const dir = tmp();
        writeRawMarker(dir, JSON.stringify({ schemaVersion: 2, anchorId: "x" }));
        (await readMarker(dir)).match(
            () => {
                throw new Error("expected a marker_corrupt error on a schema-invalid marker");
            },
            (e) => {
                expect(e.type).toBe("marker_corrupt");
            },
        );
    });
});

describe("writeMarker", () => {
    test("creates the marker file when absent", async () => {
        const dir = tmp();
        const result = await writeMarker(dir, "anchor-1");
        expect(result._unsafeUnwrap()).toEqual({ schemaVersion: 1, anchorId: "anchor-1" });
        expect(existsSync(markerPath(dir))).toBe(true);
    });

    test("is write-once: an existing marker's UUID wins and the file is not rewritten", async () => {
        const dir = tmp();
        (await writeMarker(dir, "first-uuid"))._unsafeUnwrap();
        const result = await writeMarker(dir, "second-uuid");
        expect(result._unsafeUnwrap().anchorId).toBe("first-uuid");
    });

    test("returns err on a corrupt existing marker rather than clobbering it", async () => {
        const dir = tmp();
        writeRawMarker(dir, "{ not json");
        const result = await writeMarker(dir, "anchor-1");
        expect(result.isErr()).toBe(true);
    });
});

describe("findMarkerUpwards", () => {
    test("finds a marker in the start directory itself", async () => {
        const dir = tmp();
        (await writeMarker(dir, "anchor-1"))._unsafeUnwrap();
        const result = await findMarkerUpwards(dir);
        const found = result._unsafeUnwrap();
        expect(found?.dir).toBe(dir);
        expect(found?.marker.anchorId).toBe("anchor-1");
    });

    test("walks up to the nearest ancestor that holds a marker", async () => {
        const dir = tmp();
        (await writeMarker(dir, "anchor-1"))._unsafeUnwrap();
        const deep = join(dir, "a", "b", "c");
        mkdirSync(deep, { recursive: true });
        const result = await findMarkerUpwards(deep);
        const found = result._unsafeUnwrap();
        expect(found?.dir).toBe(dir);
        expect(found?.marker.anchorId).toBe("anchor-1");
    });

    test("returns ok(null) when no ancestor holds a marker", async () => {
        const result = await findMarkerUpwards(tmp());
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap()).toBeNull();
    });
});
