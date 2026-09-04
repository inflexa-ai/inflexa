import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

        const read = await readPoolInventorySections(root);

        if (read.kind !== "sections") throw new Error("expected sections from a readable graph");
        const sections = read.sections;
        expect(sections.map((s) => s.title)).toEqual(["Python (pip)", "R"]);
        // The section carries its track as DATA. A `language` filter of the tool
        // reads that field, thus a reworded title changes no answer.
        expect(sections.map((s) => s.track)).toEqual(["python", "r"]);
        const python = sections[0]!;
        const alpha = python.packages.find((p) => p.name === "alpha");
        // The shelf of `alpha` holds two pins, newest first — the head is the answer.
        expect(alpha).toMatchObject({ name: "alpha", version: "2.0.0", storeDir: "alpha-2.0.0-00000000000a2222" });
        // The fixture records a hash marker for this directory, and the entry carries it whole.
        expect(alpha?.hash).toMatch(/^[0-9a-f]{64}$/);
        // The R section renders the DESCRIPTION spelling, because `library()` is
        // case-sensitive and the store directory carries the folded form only.
        expect(sections[1]!.packages.map((p) => p.name)).toEqual(["Rpkga", "Rpkgb"]);
    });

    test("a hash marker rides into the entry where the store directory records one", async () => {
        const root = tempStore();
        const dir = join(root, "store", "beta-0.4.1-000000000000bbbb");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, ".inflexa-hash"), `${"c".repeat(64)}\n`);

        const read = await readPoolInventorySections(root);

        const beta = read.kind === "sections" ? read.sections[0]?.packages.find((p) => p.name === "beta") : undefined;
        expect(beta?.hash).toBe("c".repeat(64));
    });

    test("an unreadable graph reads as unavailable with its reason, never as an empty pool", async () => {
        const root = mkdtempSync(join(tmpdir(), "inflexa-pool-"));
        created.push(root);

        const read = await readPoolInventorySections(root);

        expect(read.kind).toBe("unavailable");
        if (read.kind === "unavailable") expect(read.reason).toContain("dependency graph");
    });

    test("a dangling edge reads as unavailable, and the reason names the edge", async () => {
        const root = tempStore();
        // Cut one edge target out of the graph: the strict reader must refuse,
        // and the reason must carry the from/to pair the repair needs.
        const graphPath = join(root, "deps.json");
        const graph = JSON.parse(readFileSync(graphPath, "utf8")) as { nodes: Record<string, unknown> };
        delete graph.nodes["alpha-1.2.0-000000000000aaaa"];
        writeFileSync(graphPath, JSON.stringify(graph));

        const read = await readPoolInventorySections(root);

        expect(read.kind).toBe("unavailable");
        if (read.kind === "unavailable") expect(read.reason).toContain("beta-0.4.1-000000000000bbbb to alpha-1.2.0-000000000000aaaa");
    });
});
