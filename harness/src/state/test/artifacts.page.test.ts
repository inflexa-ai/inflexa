import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { countingQuerier } from "../../__tests__/setup/counting-querier.js";
import { withSchema } from "../../__tests__/setup/postgres.js";
import { countArtifactsByRuns, queryArtifactPage, type ArtifactPageQuery } from "../artifacts.js";
import type { Querier } from "../db.js";

type SeedRow = {
    analysisId: string;
    path: string;
    role?: "input" | "step_output";
    runId?: string | null;
    stepId?: string | null;
    fileType?: string | null;
    createdAt?: string;
    size?: number;
    unrecoverableAt?: string | null;
};

async function seed(pool: Pool, row: SeedRow): Promise<void> {
    await pool.query({
        text: `INSERT INTO cortex_artifacts (analysis_id, path, hash, size, role, source_step, source_run, file_type, created_at, unrecoverable_at)
               VALUES ($1, $2, 'h', $3, $4, $5, $6, $7, $8, $9)`,
        values: [
            row.analysisId,
            row.path,
            row.size ?? 1,
            row.role ?? "step_output",
            row.stepId ?? null,
            row.runId ?? null,
            row.fileType ?? null,
            row.createdAt ?? "2026-10-01T00:00:00.000Z",
            row.unrecoverableAt ?? null,
        ],
    });
}

const PATH_SORT: Pick<ArtifactPageQuery, "sort" | "limit" | "offset"> = { sort: "path", limit: 50, offset: 0 };

describe("queryArtifactPage", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        ({ pool, drop } = await withSchema("artifact_page"));
    });
    afterAll(async () => {
        await drop();
    });

    it("gives the figures that match a text, with no regard to case, in path order", async () => {
        const analysisId = "match-a1";
        await seed(pool, { analysisId, path: "runs/r2/s3/figures/volcano_up.png", runId: "r2", stepId: "s3", fileType: "figure" });
        await seed(pool, { analysisId, path: "runs/r1/s1/figures/Volcano.png", runId: "r1", stepId: "s1", fileType: "figure", size: 2048 });
        await seed(pool, { analysisId, path: "runs/r1/s1/output/volcano.csv", runId: "r1", stepId: "s1", fileType: "output" });

        const page = (await queryArtifactPage(pool, analysisId, { ...PATH_SORT, fileType: "figure", q: "VOLCANO" }))._unsafeUnwrap();

        expect(page.total).toBe(2);
        expect(page.entries).toEqual([
            {
                path: "runs/r1/s1/figures/Volcano.png",
                size: 2048,
                fileType: "figure",
                role: "step_output",
                runId: "r1",
                stepId: "s1",
                createdAt: "2026-10-01T00:00:00.000Z",
            },
            {
                path: "runs/r2/s3/figures/volcano_up.png",
                size: 1,
                fileType: "figure",
                role: "step_output",
                runId: "r2",
                stepId: "s3",
                createdAt: "2026-10-01T00:00:00.000Z",
            },
        ]);
    });

    it("matches a wildcard character only as itself", async () => {
        const analysisId = "wild-a1";
        await seed(pool, { analysisId, path: "runs/r1/s1/output/a_b.csv" });
        await seed(pool, { analysisId, path: "runs/r1/s1/output/axb.csv" });
        await seed(pool, { analysisId, path: "runs/r1/s1/output/100%.csv" });

        const underscore = (await queryArtifactPage(pool, analysisId, { ...PATH_SORT, q: "a_b" }))._unsafeUnwrap();
        const percent = (await queryArtifactPage(pool, analysisId, { ...PATH_SORT, q: "%" }))._unsafeUnwrap();

        expect(underscore.entries.map((e) => e.path)).toEqual(["runs/r1/s1/output/a_b.csv"]);
        expect(percent.entries.map((e) => e.path)).toEqual(["runs/r1/s1/output/100%.csv"]);
        expect(percent.total).toBe(1);
    });

    it("combines the run, the step, and the file type filters with AND", async () => {
        const analysisId = "and-a1";
        await seed(pool, { analysisId, path: "runs/r1/s1/output/a.csv", runId: "r1", stepId: "s1", fileType: "output" });
        await seed(pool, { analysisId, path: "runs/r1/s2/output/b.csv", runId: "r1", stepId: "s2", fileType: "output" });
        await seed(pool, { analysisId, path: "runs/r2/s1/output/c.csv", runId: "r2", stepId: "s1", fileType: "output" });
        await seed(pool, { analysisId, path: "runs/r1/s1/figures/d.png", runId: "r1", stepId: "s1", fileType: "figure" });

        const page = (await queryArtifactPage(pool, analysisId, { ...PATH_SORT, runId: "r1", stepId: "s1", fileType: "output" }))._unsafeUnwrap();

        expect(page.entries.map((e) => e.path)).toEqual(["runs/r1/s1/output/a.csv"]);
        expect(page.total).toBe(1);
    });

    it("gives an input row and a row with unrecoverable_at, with null run, step, and type", async () => {
        const analysisId = "members-a1";
        await seed(pool, { analysisId, path: "data/inputs/f1/counts.csv", role: "input" });
        await seed(pool, {
            analysisId,
            path: "runs/r1/s1/output/gone.csv",
            runId: "r1",
            stepId: "s1",
            fileType: "output",
            unrecoverableAt: "2026-10-02T00:00:00.000Z",
        });

        const page = (await queryArtifactPage(pool, analysisId, PATH_SORT))._unsafeUnwrap();

        expect(page.total).toBe(2);
        expect(page.entries[0]).toMatchObject({ path: "data/inputs/f1/counts.csv", role: "input", fileType: null, runId: null, stepId: null });
        expect(page.entries[1]).toMatchObject({ path: "runs/r1/s1/output/gone.csv", role: "step_output" });
    });

    it("orders the sort recent by the newest registration, and breaks a tie with the path", async () => {
        const analysisId = "recent-a1";
        await seed(pool, { analysisId, path: "b-old", createdAt: "2026-10-01T00:00:00.000Z" });
        await seed(pool, { analysisId, path: "a-new", createdAt: "2026-10-03T00:00:00.000Z" });
        await seed(pool, { analysisId, path: "c-new", createdAt: "2026-10-03T00:00:00.000Z" });
        await seed(pool, { analysisId, path: "d-mid", createdAt: "2026-10-02T00:00:00.000Z" });

        const page = (await queryArtifactPage(pool, analysisId, { sort: "recent", limit: 50, offset: 0 }))._unsafeUnwrap();

        expect(page.entries.map((e) => e.path)).toEqual(["a-new", "c-new", "d-mid", "b-old"]);
    });

    it("gives disjoint pages that cover the filtered rows, and an empty page past the end with the total", async () => {
        const analysisId = "paging-a1";
        for (const path of ["p1", "p2", "p3"]) await seed(pool, { analysisId, path });

        const first = (await queryArtifactPage(pool, analysisId, { sort: "path", limit: 2, offset: 0 }))._unsafeUnwrap();
        const second = (await queryArtifactPage(pool, analysisId, { sort: "path", limit: 2, offset: 2 }))._unsafeUnwrap();
        const past = (await queryArtifactPage(pool, analysisId, { sort: "path", limit: 2, offset: 4 }))._unsafeUnwrap();

        expect(first.entries.map((e) => e.path)).toEqual(["p1", "p2"]);
        expect(second.entries.map((e) => e.path)).toEqual(["p3"]);
        expect(past.entries).toEqual([]);
        expect([first.total, second.total, past.total]).toEqual([3, 3, 3]);
    });

    it("leaves the rows of a different analysis out", async () => {
        await seed(pool, { analysisId: "iso-a1", path: "runs/r1/s1/output/x.csv" });
        await seed(pool, { analysisId: "iso-a2", path: "runs/r9/s1/output/x.csv" });

        const page = (await queryArtifactPage(pool, "iso-a1", { ...PATH_SORT, q: "x.csv" }))._unsafeUnwrap();

        expect(page.entries.map((e) => e.path)).toEqual(["runs/r1/s1/output/x.csv"]);
        expect(page.total).toBe(1);
    });

    it("selects the one row of an exact path, with its run, and treats the case of the path as significant", async () => {
        const analysisId = "path-a1";
        await seed(pool, { analysisId, path: "runs/r1/s1/output/de.csv", runId: "r1", stepId: "s1", fileType: "output" });
        await seed(pool, { analysisId, path: "runs/r2/s1/output/de.csv.bak", runId: "r2", stepId: "s1", fileType: "output" });
        await seed(pool, { analysisId: "path-a2", path: "runs/r1/s1/output/de.csv", runId: "r9", stepId: "s1" });

        const exact = (await queryArtifactPage(pool, analysisId, { ...PATH_SORT, path: "runs/r1/s1/output/de.csv" }))._unsafeUnwrap();
        const wrongCase = (await queryArtifactPage(pool, analysisId, { ...PATH_SORT, path: "runs/r1/s1/output/DE.csv" }))._unsafeUnwrap();
        const wildcard = (await queryArtifactPage(pool, analysisId, { ...PATH_SORT, path: "runs/r1/s1/output/%" }))._unsafeUnwrap();

        expect(exact.total).toBe(1);
        expect(exact.entries).toMatchObject([{ path: "runs/r1/s1/output/de.csv", runId: "r1", stepId: "s1" }]);
        expect(wrongCase).toMatchObject({ entries: [], total: 0, extensionCounts: [] });
        expect(wildcard.total).toBe(0);
    });

    it("selects the rows of the extensions, with no regard to the case of the path, in path order", async () => {
        const analysisId = "ext-a1";
        await seed(pool, { analysisId, path: "runs/r1/s1/figures/a.PNG" });
        await seed(pool, { analysisId, path: "runs/r1/s1/output/b.svg" });
        await seed(pool, { analysisId, path: "runs/r1/s1/output/c.csv" });
        await seed(pool, { analysisId, path: "runs/r1/s1/output/README" });

        const page = (await queryArtifactPage(pool, analysisId, { ...PATH_SORT, extensions: ["png", "svg"] }))._unsafeUnwrap();
        const none = (await queryArtifactPage(pool, analysisId, { ...PATH_SORT, extensions: ["readme"] }))._unsafeUnwrap();
        const empty = (await queryArtifactPage(pool, analysisId, { ...PATH_SORT, extensions: [] }))._unsafeUnwrap();

        expect(page.entries.map((e) => e.path)).toEqual(["runs/r1/s1/figures/a.PNG", "runs/r1/s1/output/b.svg"]);
        expect(page.total).toBe(2);
        expect(none.total).toBe(0);
        expect(empty.total).toBe(4);
    });

    // The rule of the extension: the text after the last dot of the file name, in lower case.
    it.each([
        ["runs/r1/s1/figures/Volcano.PNG", "png"],
        ["runs/r1/s1/output/a.tar.gz", "gz"],
        ["a.tar.gz", "gz"],
        ["runs/r1/s1/output/.bashrc", null],
        [".bashrc", null],
        ["runs/r1/s1/output/notes.", null],
        ["runs/r1.v2/s1/output/README", null],
        ["runs/r1.v2/s1/output/data.csv", "csv"],
        ["runs/r1/s1/output/..x", "x"],
        ["runs/r1/s1/output/.hidden.txt", "txt"],
        ["runs/r1/s1/output/..", null],
        ["README", null],
    ])("gives the extension of %s as %p", async (path, extension) => {
        const analysisId = `rule-${path}`;
        await seed(pool, { analysisId, path });

        const page = (await queryArtifactPage(pool, analysisId, PATH_SORT))._unsafeUnwrap();

        expect(page.extensionCounts).toEqual([{ extension, count: 1 }]);
        if (extension !== null) {
            const filtered = (await queryArtifactPage(pool, analysisId, { ...PATH_SORT, extensions: [extension] }))._unsafeUnwrap();
            expect(filtered.total).toBe(1);
        }
    });

    it("counts the selected rows by extension, in extension order with null last, whatever the window", async () => {
        const analysisId = "counts-a1";
        await seed(pool, { analysisId, path: "runs/r1/s1/figures/a.png", runId: "r1" });
        await seed(pool, { analysisId, path: "runs/r1/s1/figures/b.PNG", runId: "r1" });
        await seed(pool, { analysisId, path: "runs/r1/s1/output/c.csv", runId: "r1" });
        await seed(pool, { analysisId, path: "runs/r1/s1/output/README", runId: "r1" });
        await seed(pool, { analysisId, path: "runs/r2/s1/output/d.csv", runId: "r2" });

        const page = (await queryArtifactPage(pool, analysisId, { sort: "path", limit: 1, offset: 0, runId: "r1" }))._unsafeUnwrap();
        const past = (await queryArtifactPage(pool, analysisId, { sort: "recent", limit: 1, offset: 40, runId: "r1" }))._unsafeUnwrap();

        const expected = [
            { extension: "csv", count: 1 },
            { extension: "png", count: 2 },
            { extension: null, count: 1 },
        ];
        expect(page.entries).toHaveLength(1);
        expect(page.total).toBe(4);
        expect(page.extensionCounts).toEqual(expected);
        expect(past.entries).toEqual([]);
        expect(past.total).toBe(4);
        expect(past.extensionCounts).toEqual(expected);
    });

    it("counts only the rows that the filters select", async () => {
        const analysisId = "counts-a2";
        await seed(pool, { analysisId, path: "runs/r1/s1/figures/a.png" });
        await seed(pool, { analysisId, path: "runs/r1/s1/output/c.csv" });

        const page = (await queryArtifactPage(pool, analysisId, { ...PATH_SORT, extensions: ["png"] }))._unsafeUnwrap();

        expect(page.extensionCounts).toEqual([{ extension: "png", count: 1 }]);
    });

    it("sends two statements with each filter, whatever the limit", async () => {
        const analysisId = "stmt-a1";
        for (let i = 0; i < 5; i += 1) await seed(pool, { analysisId, path: `runs/r1/s1/output/f${i}.csv`, runId: "r1", stepId: "s1", fileType: "output" });
        const queries: ArtifactPageQuery[] = [
            { sort: "path", limit: 1, offset: 0, path: "runs/r1/s1/output/f0.csv" },
            { sort: "path", limit: 1, offset: 0, extensions: ["csv"] },
            {
                sort: "recent",
                limit: 200,
                offset: 0,
                runId: "r1",
                stepId: "s1",
                fileType: "output",
                q: "f",
                path: "runs/r1/s1/output/f0.csv",
                extensions: ["csv", "png"],
            },
        ];

        for (const query of queries) {
            const counting = countingQuerier(pool);
            (await queryArtifactPage(counting.querier, analysisId, query))._unsafeUnwrap();
            expect(counting.calls()).toBe(2);
        }
    });

    it("sends two statements whatever the limit", async () => {
        const analysisId = "count-a1";
        for (let i = 0; i < 5; i += 1) await seed(pool, { analysisId, path: `f${i}` });

        const small = countingQuerier(pool);
        const large = countingQuerier(pool);
        (await queryArtifactPage(small.querier, analysisId, { sort: "path", limit: 1, offset: 0 }))._unsafeUnwrap();
        (await queryArtifactPage(large.querier, analysisId, { sort: "recent", limit: 200, offset: 0, q: "f" }))._unsafeUnwrap();

        expect(small.calls()).toBe(2);
        expect(large.calls()).toBe(2);
    });
});

describe("countArtifactsByRuns", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        ({ pool, drop } = await withSchema("artifact_counts"));
    });
    afterAll(async () => {
        await drop();
    });

    it("counts the step outputs of each run, gives no entry to a run with none, and skips the input rows", async () => {
        const analysisId = "cnt-a1";
        for (const path of ["o1", "o2", "o3"]) await seed(pool, { analysisId, path: `runs/r1/${path}`, runId: "r1", stepId: "s1" });
        await seed(pool, { analysisId, path: "data/inputs/f/in.csv", role: "input", runId: "r2" });
        await seed(pool, { analysisId: "cnt-other", path: "runs/r1/x", runId: "r1", stepId: "s1" });

        const counts = (await countArtifactsByRuns(pool, analysisId, ["r1", "r2"]))._unsafeUnwrap();

        expect(counts).toEqual([{ runId: "r1", count: 3 }]);
    });

    it("sends one statement for a list of 20 runs", async () => {
        const counting = countingQuerier(pool);

        const counts = (
            await countArtifactsByRuns(
                counting.querier,
                "cnt-a1",
                Array.from({ length: 20 }, (_, i) => `r${i}`),
            )
        )._unsafeUnwrap();

        expect(counting.calls()).toBe(1);
        expect(counts).toEqual([{ runId: "r1", count: 3 }]);
    });

    it("sends no statement for an empty list", async () => {
        const counting = countingQuerier(pool);

        const counts = (await countArtifactsByRuns(counting.querier, "cnt-a1", []))._unsafeUnwrap();

        expect(counting.calls()).toBe(0);
        expect(counts).toEqual([]);
    });
});

describe("a driver failure of the artifact reads", () => {
    // The reads under test call only `query`, thus an object with a rejecting `query` stands for the whole interface.
    const rejecting = {
        query: () => Promise.reject(new Error("connection lost")),
    } as unknown as Querier;

    it("rides the error channel of queryArtifactPage, with the op", async () => {
        const error = (await queryArtifactPage(rejecting, "a1", { sort: "path", limit: 10, offset: 0 })).match(
            () => null,
            (failure) => failure,
        );

        expect(error).toMatchObject({ type: "query_failed", op: "artifacts.queryArtifactPage" });
    });

    it("rides the error channel of countArtifactsByRuns, with the op", async () => {
        const error = (await countArtifactsByRuns(rejecting, "a1", ["r1"])).match(
            () => null,
            (failure) => failure,
        );

        expect(error).toMatchObject({ type: "query_failed", op: "artifacts.countArtifactsByRuns" });
    });
});
