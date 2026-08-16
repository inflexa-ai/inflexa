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
import {
    coerceCell,
    createArtifactReadStore,
    createProductionResolver,
    type ExtractionArm,
    type ExtractionArtifact,
    type ExtractionRequest,
} from "./production-resolver.js";
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
        // The host decided the reader before the fall-through, thus the request carries the format.
        expect(batches[0]).toEqual([{ path: "big.csv", hash, format: "csv" }]);
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

    test("an unknown format refuses before the arm, even when an arm is wired", async () => {
        // The host decides the format for both arms. An extension that names no tabular format decides no
        // reader, thus the file refuses as unavailable and the arm never receives a request for it.
        const hash = await writeArtifact("blob.dat", "some bytes that are not a table");
        const { arm, batches } = stubArm({ "blob.dat": [{ gene: "BRCA1", score: "0.5" }] });
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS, extractionArm: arm });
        const reference = valueRef("blob.dat", hash, "score", "gene", "BRCA1");

        const result = await resolver.resolve(reference, snapshotOf([{ path: "blob.dat", hash }]));

        const failure = result._unsafeUnwrapErr();
        expect(failure.reason).toBe("extraction-unavailable");
        expect(failure.detail).toContain("no supported tabular format");
        expect(batches.length).toBe(0);
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

describe("production resolver, the row bound", () => {
    /** A CSV of `count` rows. The score falls as the index rises, thus the top of a `desc` bound is the head. */
    function rankedCsv(count: number): string {
        const lines = ["gene,score"];
        for (let index = 0; index < count; index += 1) {
            lines.push(`G${index},${(count - index) / count}`);
        }
        return `${lines.join("\n")}\n`;
    }

    test("a bounded reference gives the top rows by the named column", async () => {
        const hash = await writeArtifact("bound.csv", rankedCsv(14201));
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference: ArtifactTableReference = { ...tableRef("bound.csv", hash), rowBound: { column: "score", count: 20 } };

        const result = await resolver.resolve(reference, snapshotOf([{ path: "bound.csv", hash }]));

        const resolved = result._unsafeUnwrap() as { type: "table"; rows: Row[]; total?: number };
        // The resolved table is the bounded table. Thus the card, the data asset, and the gate read one set.
        expect(resolved.rows.length).toBe(20);
        expect(resolved.rows[0].gene).toBe("G0");
        expect(resolved.rows[19].gene).toBe("G19");
        // This read is the one step that holds the whole artifact, thus it carries the pre-bound total out
        // and the page states the shown count against it.
        expect(resolved.total).toBe(14201);
    });

    test("carries no total for a reference that no bound cut", async () => {
        const hash = await writeArtifact("whole.csv", rankedCsv(5));
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });

        const result = await resolver.resolve(tableRef("whole.csv", hash), snapshotOf([{ path: "whole.csv", hash }]));

        // A whole table gives every row that the artifact holds, thus the row count is the total.
        expect(result._unsafeUnwrap()).not.toHaveProperty("total");
    });

    test("an ascending bound reads the numeric magnitude of a text cell", async () => {
        const hash = await writeArtifact("padj.csv", "gene,padj\nA,0.5\nB,1e-9\nC,0.02\n");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference: ArtifactTableReference = { ...tableRef("padj.csv", hash), rowBound: { column: "padj", count: 2, order: "asc" } };

        const result = await resolver.resolve(reference, snapshotOf([{ path: "padj.csv", hash }]));

        // A CSV holds each cell as text. A text compare would rank `0.02` before `1e-9`.
        expect((result._unsafeUnwrap() as { rows: Row[] }).rows.map((row) => row.gene)).toEqual(["B", "C"]);
    });

    test("a tie keeps the order of the file, thus two runs give one result", async () => {
        const hash = await writeArtifact("ties.csv", "gene,score\nA,1\nB,1\nC,1\nD,0\n");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference: ArtifactTableReference = { ...tableRef("ties.csv", hash), rowBound: { column: "score", count: 3 } };
        const snapshot = snapshotOf([{ path: "ties.csv", hash }]);

        const first = await resolver.resolve(reference, snapshot);
        const second = await resolver.resolve(reference, snapshot);

        expect((first._unsafeUnwrap() as { rows: Row[] }).rows.map((row) => row.gene)).toEqual(["A", "B", "C"]);
        expect(second._unsafeUnwrap()).toEqual(first._unsafeUnwrap());
    });

    test("a text column ranks in code-unit order, and never in the collation of the host", async () => {
        const hash = await writeArtifact("case.csv", "label,n\na,1\nB,2\nA,3\n");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference: ArtifactTableReference = { ...tableRef("case.csv", hash), rowBound: { column: "label", count: 3, order: "asc" } };

        const result = await resolver.resolve(reference, snapshotOf([{ path: "case.csv", hash }]));

        // The code-unit order puts each capital before each lowercase letter. An ICU collation ranks `a`
        // before `A`, and it varies with the host. The bounded rows reach the bytes of the data asset,
        // thus the order of the bound is part of the content address of that asset.
        expect((result._unsafeUnwrap() as { rows: Row[] }).rows.map((row) => row.label)).toEqual(["A", "B", "a"]);
        expect("a".localeCompare("A", "en")).toBeLessThan(0);
    });

    test("a sentinel of a numeric column ranks last under a descending bound", async () => {
        const hash = await writeArtifact("sentinel.csv", "gene,score\nA,0.1\nB,NA\nC,0.9\nD,NA\n");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference: ArtifactTableReference = { ...tableRef("sentinel.csv", hash), rowBound: { column: "score", count: 2 } };

        const result = await resolver.resolve(reference, snapshotOf([{ path: "sentinel.csv", hash }]));

        // The column is numeric, thus `NA` is the absence of a measurement. A bound of the top two rows
        // gives the two measurements, and never the two sentinels.
        expect((result._unsafeUnwrap() as { rows: Row[] }).rows.map((row) => row.gene)).toEqual(["C", "A"]);
    });

    test("a sentinel stays last under an ascending bound too", async () => {
        const hash = await writeArtifact("sentinel-asc.csv", "gene,score\nA,NA\nB,0.9\nC,0.1\n");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference: ArtifactTableReference = { ...tableRef("sentinel-asc.csv", hash), rowBound: { column: "score", count: 3, order: "asc" } };

        const result = await resolver.resolve(reference, snapshotOf([{ path: "sentinel-asc.csv", hash }]));

        // The direction orders the measurements. It never lifts a row that holds no rank.
        expect((result._unsafeUnwrap() as { rows: Row[] }).rows.map((row) => row.gene)).toEqual(["C", "B", "A"]);
    });

    test("a column where nothing parses ranks by its text", async () => {
        const hash = await writeArtifact("labels.csv", "gene,label\nA,beta\nB,alpha\nC,gamma\n");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference: ArtifactTableReference = { ...tableRef("labels.csv", hash), rowBound: { column: "label", count: 2, order: "asc" } };

        const result = await resolver.resolve(reference, snapshotOf([{ path: "labels.csv", hash }]));

        expect((result._unsafeUnwrap() as { rows: Row[] }).rows.map((row) => row.gene)).toEqual(["B", "A"]);
    });

    test("a bound over an inherited member of a plain object refuses, and it throws nothing", async () => {
        const hash = await writeArtifact("proto.csv", "gene,score\nA,1\n");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference: ArtifactTableReference = { ...tableRef("proto.csv", hash), rowBound: { column: "constructor", count: 5 } };

        // A row parses into a plain object. A membership test with `in` would find the inherited function,
        // and the rank of it would throw inside the tool that promises no throw.
        const result = await resolver.resolve(reference, snapshotOf([{ path: "proto.csv", hash }]));

        expect(result._unsafeUnwrapErr().reason).toBe("locator-out-of-range");
        expect(result._unsafeUnwrapErr().detail).toContain("constructor");
    });

    test("a bound over a column that the table does not hold refuses", async () => {
        const hash = await writeArtifact("nobound.csv", "gene,score\nA,1\n");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference: ArtifactTableReference = { ...tableRef("nobound.csv", hash), rowBound: { column: "padj", count: 5 } };

        const result = await resolver.resolve(reference, snapshotOf([{ path: "nobound.csv", hash }]));

        expect(result._unsafeUnwrapErr().reason).toBe("locator-out-of-range");
        expect(result._unsafeUnwrapErr().detail).toContain("padj");
    });

    test("the bound ranks before the projection, thus a subset that omits the bound column still bounds", async () => {
        const hash = await writeArtifact("subset.csv", "gene,score\nA,0.1\nB,0.9\n");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference: ArtifactTableReference = { ...tableRef("subset.csv", hash, ["gene"]), rowBound: { column: "score", count: 1 } };

        const result = await resolver.resolve(reference, snapshotOf([{ path: "subset.csv", hash }]));

        expect((result._unsafeUnwrap() as { rows: Row[] }).rows).toEqual([{ gene: "B" }]);
    });

    test("the fixture realization bounds the same rows as the production one", async () => {
        const hash = await writeArtifact("agree.csv", "gene,score\nA,0.1\nB,0.9\nC,0.5\n");
        const rows: Row[] = [
            { gene: "A", score: "0.1" },
            { gene: "B", score: "0.9" },
            { gene: "C", score: "0.5" },
        ];
        const snapshot = snapshotOf([{ path: "agree.csv", hash, rows }]);
        const reference: ArtifactTableReference = { ...tableRef("agree.csv", hash), rowBound: { column: "score", count: 2 } };

        const production = await createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS }).resolve(reference, snapshot);
        const fixture = await createFixtureResolver().resolve(reference, snapshot);

        // One rule of the bound serves both realizations, thus a fixture test states the production answer.
        expect(fixture._unsafeUnwrap()).toEqual(production._unsafeUnwrap());
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

describe("production resolver, the prepare batch of fall-throughs", () => {
    test("prepare sends every fall-through in one arm batch, and each later resolve answers from the arm", async () => {
        // Each file holds an odd dialect, thus the strict host parser refuses the doubt and the file falls
        // through. The extension names the reader, thus each request carries the format that the host chose.
        const odd = "gene;pvalue;score\nBRCA1;0.01;0.9\nTP53;0.02;0,8\n";
        const hashA = await writeArtifact("fall-a.csv", odd);
        const hashB = await writeArtifact("fall-b.csv", `${odd}EGFR;0.03;0,7\n`);
        const { arm, batches } = stubArm({
            "fall-a.csv": [{ gene: "BRCA1", score: "0.11" }],
            "fall-b.csv": [{ gene: "BRCA1", score: "0.22" }],
        });
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS, extractionArm: arm });
        const refA = valueRef("fall-a.csv", hashA, "score", "gene", "BRCA1");
        const refB = valueRef("fall-b.csv", hashB, "score", "gene", "BRCA1");
        const snapshot = snapshotOf([
            { path: "fall-a.csv", hash: hashA },
            { path: "fall-b.csv", hash: hashB },
        ]);

        await resolver.prepare?.([refA, refB], snapshot);

        // One arm call covers the whole batch, and the batch holds each fall-through request.
        expect(batches.length).toBe(1);
        expect(batches[0]).toHaveLength(2);
        expect(batches[0]).toEqual(
            expect.arrayContaining([
                { path: "fall-a.csv", hash: hashA, format: "csv" },
                { path: "fall-b.csv", hash: hashB, format: "csv" },
            ]),
        );

        // The later resolve reads the arm value from the cache, and it opens no new batch.
        const outA = await resolver.resolve(refA, snapshot);
        const outB = await resolver.resolve(refB, snapshot);
        expect(outA._unsafeUnwrap()).toEqual({ type: "scalar", value: "0.11" });
        expect(outB._unsafeUnwrap()).toEqual({ type: "scalar", value: "0.22" });
        expect(batches.length).toBe(1);
    });
});

describe("production resolver, the resolve path with no prepare", () => {
    test("two references at one fall-through path open one arm batch", async () => {
        // A resolve with no prior prepare writes what it read into the per-pass cache. Thus the second
        // reference at the same path answers from the cache, and it starts no second container.
        const hash = await writeArtifact("no-prepare.csv", "gene;score\nBRCA1;0.9\nTP53;0,8\n");
        const { arm, batches } = stubArm({
            "no-prepare.csv": [
                { gene: "BRCA1", score: "0.11" },
                { gene: "TP53", score: "0.22" },
            ],
        });
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS, extractionArm: arm });
        const snapshot = snapshotOf([{ path: "no-prepare.csv", hash }]);

        const first = await resolver.resolve(valueRef("no-prepare.csv", hash, "score", "gene", "BRCA1"), snapshot);
        const second = await resolver.resolve(valueRef("no-prepare.csv", hash, "score", "gene", "TP53"), snapshot);

        expect(first._unsafeUnwrap()).toEqual({ type: "scalar", value: "0.11" });
        expect(second._unsafeUnwrap()).toEqual({ type: "scalar", value: "0.22" });
        expect(batches.length).toBe(1);
    });
});

describe("production resolver, the shared read cache", () => {
    test("a second resolver over the same cache reads one unchanged file through no second arm batch", async () => {
        // A preview and the record that follows it are two resolvers over one analysis. The shared cache
        // carries the rows of the unchanged file, thus the second pass starts no second container.
        const hash = await writeArtifact("shared.csv", "gene;score\nBRCA1;0.9\nTP53;0,8\n");
        const { arm, batches } = stubArm({ "shared.csv": [{ gene: "BRCA1", score: "0.33" }] });
        const readCache = createArtifactReadStore().forAnalysis(ANALYSIS);
        const reference = valueRef("shared.csv", hash, "score", "gene", "BRCA1");
        const snapshot = snapshotOf([{ path: "shared.csv", hash }]);

        const first = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS, extractionArm: arm, readCache });
        await first.prepare?.([reference], snapshot);
        const second = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS, extractionArm: arm, readCache });
        await second.prepare?.([reference], snapshot);
        const result = await second.resolve(reference, snapshot);

        expect(result._unsafeUnwrap()).toEqual({ type: "scalar", value: "0.33" });
        expect(batches.length).toBe(1);
    });

    test("a file that changed on disk reads again through the arm", async () => {
        // The stat signature guards the shared rows. New bytes hold a new signature, thus the cache answers
        // for the old bytes only and the new bytes cost one read of their own.
        await writeArtifact("shared-change.csv", "gene;score\nBRCA1;0.9\nTP53;0,8\n");
        const { arm, batches } = stubArm({ "shared-change.csv": [{ gene: "BRCA1", score: "0.44" }] });
        const readCache = createArtifactReadStore().forAnalysis(ANALYSIS);

        const before = await computeSha256File(join(root, "shared-change.csv"));
        const first = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS, extractionArm: arm, readCache });
        await first.prepare?.([valueRef("shared-change.csv", before, "score", "gene", "BRCA1")], snapshotOf([{ path: "shared-change.csv", hash: before }]));

        const after = await writeArtifact("shared-change.csv", "gene;score;rank\nBRCA1;0.9;1\nTP53;0,8;2\nEGFR;0,7;3\n");
        const reference = valueRef("shared-change.csv", after, "score", "gene", "BRCA1");
        const second = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS, extractionArm: arm, readCache });
        const result = await second.resolve(reference, snapshotOf([{ path: "shared-change.csv", hash: after }]));

        expect(result._unsafeUnwrap()).toEqual({ type: "scalar", value: "0.44" });
        expect(batches.length).toBe(2);
    });
});

describe("production resolver, the numeric row filter", () => {
    test("a numeric filter value selects a string cell, and both realizations agree", async () => {
        // A CSV holds the cluster id as the string "3". A filter value of the number 3 must select it, thus
        // the compare reads both sides as a number.
        const rows: Row[] = [
            { cluster: "3", score: "0.90" },
            { cluster: "10", score: "0.80" },
        ];
        const hash = await writeArtifact("cluster.csv", "cluster,score\n3,0.90\n10,0.80\n");
        const reference: ArtifactValueReference = {
            kind: "artifact-value",
            path: "cluster.csv",
            hash,
            locator: { column: "score", rowFilter: { column: "cluster", op: "eq", value: 3 } },
        };

        const production = await createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS }).resolve(
            reference,
            snapshotOf([{ path: "cluster.csv", hash }]),
        );
        const fixture = await createFixtureResolver().resolve(reference, snapshotOf([{ path: "cluster.csv", hash, rows }]));

        expect(production._unsafeUnwrap()).toEqual({ type: "scalar", value: "0.90" });
        expect(production._unsafeUnwrap()).toEqual(fixture._unsafeUnwrap());
    });

    test("a non-numeric filter value still selects by its exact text", async () => {
        // A label that no side reads as a number compares by exact text, thus the string path is unchanged.
        const hash = await writeArtifact("label.csv", "label,score\nc3,0.90\nc10,0.80\n");
        const reference = valueRef("label.csv", hash, "score", "label", "c10");

        const result = await createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS }).resolve(
            reference,
            snapshotOf([{ path: "label.csv", hash }]),
        );

        expect(result._unsafeUnwrap()).toEqual({ type: "scalar", value: "0.80" });
    });
});

describe("production resolver, a non-finite cell", () => {
    test("coerceCell drops a NaN and an Infinity, the same as the extraction script", () => {
        // The extraction script drops a NaN or an Infinity to `None`. The host coercion drops the same, thus
        // the two arms read one parquet float column the same way. A finite number stays a cell.
        expect(coerceCell(Number.NaN)).toBeUndefined();
        expect(coerceCell(Number.POSITIVE_INFINITY)).toBeUndefined();
        expect(coerceCell(Number.NEGATIVE_INFINITY)).toBeUndefined();
        expect(coerceCell(0.7)).toBe(0.7);
    });

    test("a JSON Infinity cell reads as absent, thus the reference fails locator-out-of-range", async () => {
        // `JSON.parse` reads an over-large literal as Infinity. The coercion drops it, thus the row omits the
        // column and the scalar reference finds no value.
        const hash = await writeArtifact("inf.json", '[{"gene":"BRCA1","score":1e999}]');
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const reference = valueRef("inf.json", hash, "score", "gene", "BRCA1");

        const result = await resolver.resolve(reference, snapshotOf([{ path: "inf.json", hash }]));

        expect(result._unsafeUnwrapErr().reason).toBe("locator-out-of-range");
    });
});

describe("production resolver, a blank line in a delimited file", () => {
    test("a blank line in the middle of a CSV parses clean in process", async () => {
        // The blank line drops, thus the file parses in process and needs no arm. A resolver with no arm
        // proves the in-process read, because a fall-through would fail extraction-unavailable.
        const hash = await writeArtifact("blank-mid.csv", "gene,score\nBRCA1,0.9\n\nTP53,0.8\n");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });
        const snapshot = snapshotOf([{ path: "blank-mid.csv", hash }]);

        const first = await resolver.resolve(valueRef("blank-mid.csv", hash, "score", "gene", "BRCA1"), snapshot);
        const second = await resolver.resolve(valueRef("blank-mid.csv", hash, "score", "gene", "TP53"), snapshot);

        expect(first._unsafeUnwrap()).toEqual({ type: "scalar", value: "0.9" });
        expect(second._unsafeUnwrap()).toEqual({ type: "scalar", value: "0.8" });
    });

    test("a doubled trailing newline parses clean in process", async () => {
        const hash = await writeArtifact("double-newline.csv", "gene,score\nBRCA1,0.9\nTP53,0.8\n\n");
        const resolver = createProductionResolver({ workspaceRoot: root, analysisId: ANALYSIS });

        const result = await resolver.resolve(
            valueRef("double-newline.csv", hash, "score", "gene", "TP53"),
            snapshotOf([{ path: "double-newline.csv", hash }]),
        );

        expect(result._unsafeUnwrap()).toEqual({ type: "scalar", value: "0.8" });
    });
});
