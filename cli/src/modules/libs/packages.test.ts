import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPoolInventorySections } from "./packages.ts";

// The pool-scope inventory: what the conversation agent and the planner
// answer package presence from. It reads the graph, never a farm, thus an
// empty new farm cannot make a held package read as absent.

const FIXTURE = join(import.meta.dir, "test-fixtures", "farm-parity");

const created: string[] = [];

function tempStore(): string {
    const root = mkdtempSync(join(tmpdir(), "inflexa-pool-"));
    created.push(root);
    cpSync(FIXTURE, root, { recursive: true });
    return root;
}

afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readPoolInventorySections", () => {
    test("every advertised distribution lists at its newest pin, with its store directory", async () => {
        const root = tempStore();

        const sections = await readPoolInventorySections(root);

        if (sections === null) throw new Error("expected sections from a readable graph");
        expect(sections.map((s) => s.title)).toEqual(["Python (pip)", "R"]);
        const python = sections[0]!;
        const alpha = python.packages.find((p) => p.name === "alpha");
        // The shelf of `alpha` holds two pins, newest first — the head is the answer.
        expect(alpha).toMatchObject({ name: "alpha", version: "2.0.0", storeDir: "alpha-2.0.0-00000000000a2222" });
        // The fixture records a hash marker for this directory, and the entry carries it whole.
        expect(alpha?.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(sections[1]!.packages.map((p) => p.name)).toEqual(["rpkga", "rpkgb"]);
    });

    test("a hash marker rides into the entry where the store directory records one", async () => {
        const root = tempStore();
        const dir = join(root, "store", "beta-0.4.1-000000000000bbbb");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, ".inflexa-hash"), `${"c".repeat(64)}\n`);

        const sections = await readPoolInventorySections(root);

        const beta = sections?.[0]?.packages.find((p) => p.name === "beta");
        expect(beta?.hash).toBe("c".repeat(64));
    });

    test("an unreadable graph reads as null, never as an empty pool", async () => {
        const root = mkdtempSync(join(tmpdir(), "inflexa-pool-"));
        created.push(root);

        expect(await readPoolInventorySections(root)).toBeNull();
    });
});
