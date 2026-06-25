import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freshDb } from "../../test_support/db.ts";
import { resolveOutputDir } from "./output.ts";
import { writeMarker } from "../anchor/marker.ts";
import { insertAnchor } from "../../db/primary_mutation.ts";
import { env } from "../../lib/env.ts";
import { asStr256 } from "../../lib/types.ts";
import type { Analysis } from "../../types/analysis.ts";

const created: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "inflexa-output-"));
    created.push(dir);
    return dir;
}

function analysis(overrides: Partial<Analysis> = {}): Analysis {
    return {
        id: "ana1",
        createdAt: 1,
        updatedAt: 1,
        name: asStr256("A"),
        slug: "myslug",
        outputDirectory: null,
        anchorId: "A1",
        projectId: null,
        ...overrides,
    };
}

function insertAnchorAt(id: string, cachedPath: string): void {
    insertAnchor({ id, createdAt: 1, updatedAt: 1, cachedPath, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
}

beforeEach(() => {
    freshDb();
});

afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
});

describe("resolveOutputDir", () => {
    test("case 1 — an explicit outputDirectory is returned unchanged", () => {
        expect(resolveOutputDir(analysis({ outputDirectory: "/explicit/out" }))._unsafeUnwrap()).toBe("/explicit/out");
    });

    test("case 2 — a resolvable, writable anchor → beside the data under .inflexa/analyses/<slug>", () => {
        const home = tmp();
        writeMarker(home, "A1");
        insertAnchorAt("A1", home);
        expect(resolveOutputDir(analysis())._unsafeUnwrap()).toBe(join(home, ".inflexa", "analyses", "myslug"));
    });

    test("case 3 — an unresolvable anchor → the managed fallback dir", () => {
        const gone = tmp();
        insertAnchorAt("A1", gone);
        rmSync(gone, { recursive: true, force: true }); // anchor can no longer be located
        expect(resolveOutputDir(analysis())._unsafeUnwrap()).toBe(join(env.outputFallbackDir, "myslug"));
    });
});
