import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../test_support/cli.ts";
import { closeDb } from "../../db/primary.ts";
import { freshDb } from "../../test_support/db.ts";
import { insertAnchor } from "../../db/primary_mutation.ts";
import { getAnchor } from "../../db/primary_query.ts";
import { canonicalPath, writeMarker } from "./marker.ts";

const created: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "inflexa-repair-"));
    created.push(dir);
    return dir;
}

beforeEach(() => {
    freshDb();
});

afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
});

describe("inflexa repair (e2e)", () => {
    test("re-points an anchor's cached path to the marker's current location", () => {
        const moved = tmp();
        writeMarker(moved, "A1")._unsafeUnwrap();
        insertAnchor({ id: "A1", createdAt: 1, updatedAt: 1, cachedPath: "/stale/old/path", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        closeDb();

        const result = runCli(["repair", moved]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Repaired anchor A1");
        // Read back through the DB: the cached path now matches the marker's (canonical) location.
        expect(getAnchor("A1")._unsafeUnwrap()?.cachedPath).toBe(canonicalPath(moved));
    });

    test("fails when there is no marker at the path", () => {
        const empty = tmp();
        closeDb();
        const result = runCli(["repair", empty]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("No marker");
    });
});
