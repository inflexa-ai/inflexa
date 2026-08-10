/**
 * The tests of the production resolver. Each test writes a real file into a temp workspace, thus the read
 * strategy runs against bytes on disk. The identity layer, the host fast path, the cap, and the
 * fall-through each get a case. One case matches the outcome against the fixture realization, thus the two
 * realizations stay substitutable.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ArtifactTableReference, ArtifactValueReference, Reference } from "../contracts/report-reference.js";
import { computeSha256File } from "../lib/fs-helpers.js";
import { createFixtureResolver } from "./fixture-resolver.js";
import { createProductionResolver, type ExtractionArm, type ExtractionArtifact, type ExtractionRequest } from "./production-resolver.js";
import type { ArtifactSnapshot, ReportSnapshot } from "./reference-resolver.js";

type Row = Record<string, string | number>;

const ANALYSIS = "analysis-prod";
const PARQUET_FIXTURE = fileURLToPath(new URL("./__fixtures__/sample.parquet", import.meta.url));

let root: string;

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "prod-resolver-"));
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

/** Write one artifact under the workspace root, and give back its on-disk content hash. */
async function writeArtifact(relPath: string, content: string | Buffer): Promise<string> {
    const absolute = join(root, relPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    return computeSha256File(absolute);
}

/** Build a scalar reference that selects a cell by a column and an equality filter. */
function valueRef(
    path: string,
    hash: string,
    column: string,
    filterColumn: string,
    filterValue: string | number,
    assert?: { value: string | number; tolerance?: number },
): ArtifactValueReference {
    return {
        kind: "artifact-value",
        path,
        hash,
        locator: { column, rowFilter: { column: filterColumn, op: "eq", value: filterValue } },
        ...(assert ? { assert } : {}),
    };
}

/** Build a whole-table reference, or a projected-table reference when `columns` is present. */
function tableRef(path: string, hash: string, columns?: string[]): ArtifactTableReference {
    return { kind: "artifact-table", path, hash, ...(columns ? { columns } : {}) };
}

/** Build a snapshot from the given entries. The fixture reads the `rows`, and the production reads the file. */
function snapshotOf(entries: Array<{ path: string; hash: string; fileType?: string | null; rows?: Row[] }>): ReportSnapshot {
    const artifacts: Record<string, ArtifactSnapshot> = {};
    for (const entry of entries) {
        artifacts[entry.path] = {
            hash: entry.hash,
            ...(entry.fileType !== undefined ? { fileType: entry.fileType } : {}),
            ...(entry.rows !== undefined ? { rows: entry.rows } : {}),
        };
    }
    return { artifacts };
}

/** Build a stub extraction arm over a path-to-rows map, and record each batch that it receives. */
function stubArm(rowsByPath: Record<string, Row[]>): { arm: ExtractionArm; batches: ExtractionRequest[][] } {
    const batches: ExtractionRequest[][] = [];
    const arm: ExtractionArm = {
        async extract(requests) {
            batches.push([...requests]);
            const out = new Map<string, ExtractionArtifact>();
            for (const request of requests) {
                const rows = rowsByPath[request.path];
                if (rows !== undefined) {
                    out.set(request.path, { rows });
                }
            }
            return out;
        },
    };
    return { arm, batches };
}

describe("production resolver, the identity layer", () => {
    test("a drifted file fails hash-mismatch, and no parser runs", async () => {
        const onDisk = await writeArtifact("drift.csv", "gene,score\nBRCA1,0.9\n");
        const staleHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
        const reference = valueRef("drift.csv", staleHash, "score", "gene", "BRCA1");
        const snapshot = snapshotOf([{ path: "drift.csv", hash: staleHash }]);

        // The arm records each call. A hash mismatch that reached the parser would fall through to the arm,
        // thus an untouched arm is the proof that no parse ran.
        const { arm, batches } = stubArm({ "drift.csv": [{ gene: "BRCA1", score: "0.9" }] });
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS, extractionArm: arm });

        const result = await resolver.resolve(reference, snapshot);

        expect(result.isErr()).toBe(true);
        expect(result._unsafeUnwrapErr().reason).toBe("hash-mismatch");
        expect(result._unsafeUnwrapErr().detail).toContain(onDisk);
        expect(batches.length).toBe(0);
    });

    test("a missing artifact fails artifact-missing", async () => {
        const reference = valueRef("gone.csv", "sha256:abc", "score", "gene", "BRCA1");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });

        const result = await resolver.resolve(reference, snapshotOf([]));

        expect(result._unsafeUnwrapErr().reason).toBe("artifact-missing");
    });
});

describe("production resolver, the host fast path", () => {
    test("a CSV cell resolves in process", async () => {
        const hash = await writeArtifact("de.csv", "gene,score\nBRCA1,0.9\nTP53,0.8\n");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference = valueRef("de.csv", hash, "score", "gene", "BRCA1");

        const result = await resolver.resolve(reference, snapshotOf([{ path: "de.csv", hash }]));

        expect(result._unsafeUnwrap()).toEqual({ type: "scalar", value: "0.9" });
    });

    test("a TSV cell resolves in process", async () => {
        const hash = await writeArtifact("de.tsv", "gene\tscore\nBRCA1\t0.9\nTP53\t0.8\n");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference = valueRef("de.tsv", hash, "score", "gene", "TP53");

        const result = await resolver.resolve(reference, snapshotOf([{ path: "de.tsv", hash }]));

        expect(result._unsafeUnwrap()).toEqual({ type: "scalar", value: "0.8" });
    });

    test("a JSON cell resolves in process, and it keeps the numeric type", async () => {
        const hash = await writeArtifact(
            "de.json",
            JSON.stringify([
                { gene: "BRCA1", score: 0.9 },
                { gene: "TP53", score: 0.8 },
            ]),
        );
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference = valueRef("de.json", hash, "score", "gene", "BRCA1");

        const result = await resolver.resolve(reference, snapshotOf([{ path: "de.json", hash }]));

        expect(result._unsafeUnwrap()).toEqual({ type: "scalar", value: 0.9 });
    });

    test("a parquet cell resolves in process through the pure-JavaScript reader", async () => {
        const bytes = await readFile(PARQUET_FIXTURE);
        const hash = await writeArtifact("de.parquet", bytes);
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference = valueRef("de.parquet", hash, "score", "gene", "EGFR");

        const result = await resolver.resolve(reference, snapshotOf([{ path: "de.parquet", hash }]));

        expect(result._unsafeUnwrap()).toEqual({ type: "scalar", value: 0.7 });
    });

    test("a quoted CSV field that holds the delimiter resolves", async () => {
        const hash = await writeArtifact("quoted.csv", 'gene,note\nBRCA1,"one, two"\n');
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference = valueRef("quoted.csv", hash, "note", "gene", "BRCA1");

        const result = await resolver.resolve(reference, snapshotOf([{ path: "quoted.csv", hash }]));

        expect(result._unsafeUnwrap()).toEqual({ type: "scalar", value: "one, two" });
    });
});

describe("production resolver, the cap", () => {
    test("a 4 MiB cap sends a larger file to the arm", async () => {
        const bytes = Buffer.alloc(5 * 1024 * 1024, 0x61);
        const hash = await writeArtifact("big.csv", bytes);
        const { arm, batches } = stubArm({ "big.csv": [{ gene: "BRCA1", score: "0.42" }] });
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS, cap: 4 * 1024 * 1024, extractionArm: arm });
        const reference = valueRef("big.csv", hash, "score", "gene", "BRCA1");

        const result = await resolver.resolve(reference, snapshotOf([{ path: "big.csv", hash }]));

        expect(result._unsafeUnwrap()).toEqual({ type: "scalar", value: "0.42" });
        expect(batches.length).toBe(1);
        expect(batches[0]).toEqual([{ path: "big.csv", hash }]);
    });

    test("the same larger file resolves in process under the default cap", async () => {
        // A quoted field holds a 5 MiB note with no delimiter and no line break, thus the file is a valid
        // CSV that is over 4 MiB and under the 16 MiB default. The default cap reads it in process.
        const note = "x".repeat(5 * 1024 * 1024);
        const hash = await writeArtifact("big-default.csv", `gene,score,note\nBRCA1,0.42,"${note}"\n`);
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference = valueRef("big-default.csv", hash, "score", "gene", "BRCA1");

        const result = await resolver.resolve(reference, snapshotOf([{ path: "big-default.csv", hash }]));

        expect(result._unsafeUnwrap()).toEqual({ type: "scalar", value: "0.42" });
    });
});

describe("production resolver, the fall-through", () => {
    test("an odd CSV dialect goes to the stubbed arm, and the stub answer comes back", async () => {
        // The comma parser reads a ragged file, because one line holds a decimal comma. The strict parser
        // refuses the doubt, thus the file falls through.
        const hash = await writeArtifact("odd.csv", "gene;pvalue;score\nBRCA1;0.01;0.9\nTP53;0.02;0,8\n");
        const { arm, batches } = stubArm({ "odd.csv": [{ gene: "TP53", score: "0.8" }] });
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS, extractionArm: arm });
        const reference = valueRef("odd.csv", hash, "score", "gene", "TP53");

        const result = await resolver.resolve(reference, snapshotOf([{ path: "odd.csv", hash }]));

        expect(result._unsafeUnwrap()).toEqual({ type: "scalar", value: "0.8" });
        expect(batches.length).toBe(1);
    });

    test("the same odd dialect fails extraction-unavailable when no arm is wired", async () => {
        const hash = await writeArtifact("odd2.csv", "gene;pvalue;score\nBRCA1;0.01;0.9\nTP53;0.02;0,8\n");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference = valueRef("odd2.csv", hash, "score", "gene", "TP53");

        const result = await resolver.resolve(reference, snapshotOf([{ path: "odd2.csv", hash }]));

        const failure = result._unsafeUnwrapErr();
        expect(failure.reason).toBe("extraction-unavailable");
        expect(failure.detail).toContain("odd2.csv");
    });

    test("an unknown format falls through", async () => {
        const hash = await writeArtifact("blob.dat", "some bytes that are not a table");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference = valueRef("blob.dat", hash, "score", "gene", "BRCA1");

        const result = await resolver.resolve(reference, snapshotOf([{ path: "blob.dat", hash }]));

        expect(result._unsafeUnwrapErr().reason).toBe("extraction-unavailable");
    });
});

describe("production resolver, an absent arm beside under-cap successes", () => {
    test("nine under-cap references resolve, and the one over-cap reference fails extraction-unavailable", async () => {
        const references: Reference[] = [];
        const entries: Array<{ path: string; hash: string }> = [];
        for (let n = 0; n < 9; n += 1) {
            const path = `small-${n}.csv`;
            const hash = await writeArtifact(path, `gene,score\nBRCA1,0.${n}\n`);
            references.push(valueRef(path, hash, "score", "gene", "BRCA1"));
            entries.push({ path, hash });
        }
        const overCapHash = await writeArtifact("over-cap.csv", Buffer.alloc(5 * 1024 * 1024, 0x61));
        references.push(valueRef("over-cap.csv", overCapHash, "score", "gene", "BRCA1"));
        entries.push({ path: "over-cap.csv", hash: overCapHash });

        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS, cap: 4 * 1024 * 1024 });
        const snapshot = snapshotOf(entries);
        await resolver.prepare?.(references, snapshot);

        const outcomes = await Promise.all(references.map((reference) => resolver.resolve(reference, snapshot)));

        const under = outcomes.slice(0, 9);
        for (let n = 0; n < 9; n += 1) {
            expect(under[n]._unsafeUnwrap()).toEqual({ type: "scalar", value: `0.${n}` });
        }
        expect(outcomes[9]._unsafeUnwrapErr().reason).toBe("extraction-unavailable");
    });
});

describe("production resolver, the assert agreement with the fixture", () => {
    test("a passing tolerance gives the same outcome through both realizations", async () => {
        const rows: Row[] = [{ gene: "BRCA1", score: "0.104" }];
        const hash = await writeArtifact("assert.csv", "gene,score\nBRCA1,0.104\n");
        const reference = valueRef("assert.csv", hash, "score", "gene", "BRCA1", { value: 0.1, tolerance: 0.01 });

        const production = await createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS }).resolve(
            reference,
            snapshotOf([{ path: "assert.csv", hash }]),
        );
        const fixture = await createFixtureResolver().resolve(reference, snapshotOf([{ path: "assert.csv", hash, rows }]));

        expect(production._unsafeUnwrap()).toEqual(fixture._unsafeUnwrap());
        expect(production._unsafeUnwrap()).toEqual({ type: "scalar", value: "0.104" });
    });

    test("a failing tolerance gives the same reason and detail through both realizations", async () => {
        const rows: Row[] = [{ gene: "BRCA1", score: "0.104" }];
        const hash = await writeArtifact("assert2.csv", "gene,score\nBRCA1,0.104\n");
        const reference = valueRef("assert2.csv", hash, "score", "gene", "BRCA1", { value: 0.1, tolerance: 0.001 });

        const production = await createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS }).resolve(
            reference,
            snapshotOf([{ path: "assert2.csv", hash }]),
        );
        const fixture = await createFixtureResolver().resolve(reference, snapshotOf([{ path: "assert2.csv", hash, rows }]));

        expect(production._unsafeUnwrapErr()).toEqual(fixture._unsafeUnwrapErr());
        expect(production._unsafeUnwrapErr().reason).toBe("assertion-failed");
    });
});

describe("production resolver, the table and chart values", () => {
    test("a whole-table reference gives rows, and the resolved table matches the file", async () => {
        const hash = await writeArtifact("table.csv", "gene,score\nBRCA1,0.9\nTP53,0.8\n");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference = tableRef("table.csv", hash);

        const result = await resolver.resolve(reference, snapshotOf([{ path: "table.csv", hash }]));

        expect(result._unsafeUnwrap()).toEqual({
            type: "table",
            rows: [
                { gene: "BRCA1", score: "0.9" },
                { gene: "TP53", score: "0.8" },
            ],
        });
    });

    test("a projected-table reference keeps the named columns, and refuses an absent column", async () => {
        const hash = await writeArtifact("chart.csv", "gene,score,rank\nBRCA1,0.9,1\nTP53,0.8,2\n");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const snapshot = snapshotOf([{ path: "chart.csv", hash }]);

        const kept = await resolver.resolve(tableRef("chart.csv", hash, ["gene", "score"]), snapshot);
        expect(kept._unsafeUnwrap()).toEqual({
            type: "table",
            columns: ["gene", "score"],
            rows: [
                { gene: "BRCA1", score: "0.9" },
                { gene: "TP53", score: "0.8" },
            ],
        });

        const absent = await resolver.resolve(tableRef("chart.csv", hash, ["gene", "logfc"]), snapshot);
        expect(absent._unsafeUnwrapErr().reason).toBe("locator-out-of-range");
    });
});

describe("production resolver, the prepare cache", () => {
    test("after a prepare, resolve answers from the cache even when the file is gone", async () => {
        const hash = await writeArtifact("cached.csv", "gene,score\nBRCA1,0.9\n");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference = valueRef("cached.csv", hash, "score", "gene", "BRCA1");
        const snapshot = snapshotOf([{ path: "cached.csv", hash }]);

        await resolver.prepare?.([reference], snapshot);
        await rm(join(root, "cached.csv"));

        const result = await resolver.resolve(reference, snapshot);

        expect(result._unsafeUnwrap()).toEqual({ type: "scalar", value: "0.9" });
    });

    test("a resolve with no prior prepare reads the file fresh, thus a gone file fails", async () => {
        const hash = await writeArtifact("fresh.csv", "gene,score\nBRCA1,0.9\n");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference = valueRef("fresh.csv", hash, "score", "gene", "BRCA1");
        const snapshot = snapshotOf([{ path: "fresh.csv", hash }]);

        await rm(join(root, "fresh.csv"));

        const result = await resolver.resolve(reference, snapshot);

        expect(result._unsafeUnwrapErr().reason).toBe("unreadable-artifact");
    });
});
