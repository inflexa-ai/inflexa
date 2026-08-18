import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../../__tests__/setup/postgres.js";
import { completeDataProfile, failDataProfile, tryRerunDataProfile, tryStartDataProfile, type DataProfileResult } from "../../state/index.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createInspectDataProfileTool, type InspectDataProfileOutput } from "./inspect-data-profile.js";

// `makeToolContext` builds a session scoped to this analysis.
const ANALYSIS = "analysis-001";

let pool: Pool;
let drop: () => Promise<void>;
let tool: ReturnType<typeof createInspectDataProfileTool>;

/** Insert the analysis-state row the profile ledger hangs off. */
async function seedAnalysis(seed: string[] = ["file-aaa", "file-bbb"], status: string | null = "pending"): Promise<void> {
    const now = new Date().toISOString();
    await pool.query({
        text: `INSERT INTO cortex_analysis_state
           (analysis_id, status, context, data_profile_status, seed_input_file_ids, created_at, updated_at)
           VALUES ($1, 'active', NULL, $2, $3::jsonb, $4, $5)`,
        values: [ANALYSIS, status, JSON.stringify(seed), now, now],
    });
}

/** Drive the ledger to `completed` with a stored result, the way the workflow does. */
async function completeWith(result: DataProfileResult): Promise<void> {
    (await tryStartDataProfile(pool, ANALYSIS))._unsafeUnwrap();
    (await completeDataProfile(pool, ANALYSIS, result))._unsafeUnwrap();
}

async function run(input: { scope?: "overview" | "kinds" | "files"; page?: number; pageSize?: number } = {}): Promise<InspectDataProfileOutput> {
    const { ctx } = makeToolContext();
    return (await tool.execute(input, ctx))._unsafeUnwrap();
}

function makeResult(overrides: Partial<DataProfileResult> = {}): DataProfileResult {
    return {
        summary: "Bulk RNA-seq of rectal biopsies, 24 samples.",
        files: [
            {
                path: "data/inputs/f1/counts.csv",
                description: "Raw count matrix",
                dataType: "count-matrix",
                format: "CSV",
                rows: 20531,
                cols: 24,
                tags: ["counts"],
                warnings: ["3 low-depth samples"],
                metrics: { sparsity: 0.41 },
            },
            { path: "data/inputs/f2/metadata.csv", description: "Sample metadata", dataType: "clinical-metadata", format: "CSV", rows: 24, cols: 6 },
        ],
        inputFileIds: ["file-aaa", "file-bbb"],
        profiledAt: "2026-06-09T10:00:00.000Z",
        domain: "transcriptomics",
        subtype: "bulk-rna-seq",
        organism: { scientificName: "Homo sapiens", taxonId: "9606", source: "metadata", confidence: "high" },
        tissue: "rectal mucosal biopsy",
        cellType: "bulk tissue",
        condition: "Ulcerative Colitis vs healthy controls",
        accessions: ["GSE123456"],
        experimentalDesign: "12 UC vs 12 control, paired by batch.",
        qualityAssessment: { concerns: ["batch confounded with group"], strengths: ["balanced groups"] },
        ...overrides,
    };
}

/** Files that page: N records, each distinguishable by path. */
function filesResult(count: number): DataProfileResult {
    return makeResult({
        files: Array.from({ length: count }, (_, i) => ({
            path: `data/inputs/f${i}/counts.csv`,
            description: `Matrix ${i}`,
            dataType: "count-matrix",
            format: "CSV",
            rows: 100 + i,
            cols: 4,
        })),
    });
}

beforeAll(async () => {
    ({ pool, drop } = await withSchema("inspect_data_profile"));
    tool = createInspectDataProfileTool(pool);
});

afterAll(async () => {
    await drop();
});

/** Each test owns the single analysis row; wipe it between them. */
async function resetLedger(): Promise<void> {
    await pool.query("DELETE FROM cortex_analysis_state");
}

describe("the tool contract", () => {
    it("declares a bounded, paged input surface", () => {
        const schema = tool.jsonSchema as { properties: Record<string, unknown> };
        expect(tool.id).toBe("inspect_data_profile");
        expect(Object.keys(schema.properties).sort()).toEqual(["page", "pageSize", "scope"]);
        // The description must say where the profile lives, because nothing else will.
        expect(tool.description).toContain("AUTHORITATIVE");
        expect(tool.description).toContain("NO data-profile file");
        // A tool is self-describing at attach time, so the failed state's qualifier
        // has to be here or the agent never learns it exists — and it must claim only
        // what the tool can produce.
        expect(tool.description).toContain("failedAt");
        expect(tool.description).toContain("PAST attempt");
    });
});

describe("lifecycle variants — every one is data, not an error", () => {
    it("absent: no analysis row at all", async () => {
        await resetLedger();
        const out = await run();
        expect(out.state).toBe("absent");
    });

    it("absent: profiling completed with no result — the analysis has no input files", async () => {
        await resetLedger();
        await seedAnalysis();
        (await tryStartDataProfile(pool, ANALYSIS))._unsafeUnwrap();
        (await completeDataProfile(pool, ANALYSIS))._unsafeUnwrap();

        const out = await run();
        expect(out.state).toBe("absent");
        expect(out).toHaveProperty("message");
    });

    it("pending: profiling is running and nothing has been stored yet", async () => {
        await resetLedger();
        await seedAnalysis();
        (await tryStartDataProfile(pool, ANALYSIS))._unsafeUnwrap();

        const out = await run();
        expect(out.state).toBe("pending");
        expect(out).toMatchObject({ status: "running" });
    });

    it("failed: reports a past attempt with its time, not a verdict on the current inputs", async () => {
        await resetLedger();
        await seedAnalysis();
        (await tryStartDataProfile(pool, ANALYSIS))._unsafeUnwrap();
        (await failDataProfile(pool, ANALYSIS, "sandbox crashed"))._unsafeUnwrap();

        const out = await run();
        expect(out.state).toBe("failed");
        expect(out).toMatchObject({ error: "sandbox crashed" });
        expect(typeof (out as { failedAt: string | null }).failedAt).toBe("string");
        const message = (out as { message: string }).message;
        expect(message).toContain("earlier attempt");
        expect(message).toContain("cannot establish");
    });

    it("failed: a row recording no completion time answers failedAt: null, not a fabricated one", async () => {
        await resetLedger();
        await seedAnalysis();
        (await tryStartDataProfile(pool, ANALYSIS))._unsafeUnwrap();
        (await failDataProfile(pool, ANALYSIS, "sandbox crashed"))._unsafeUnwrap();
        await pool.query({
            text: "UPDATE cortex_analysis_state SET data_profile_completed_at = NULL WHERE analysis_id = $1",
            values: [ANALYSIS],
        });

        const wire = JSON.parse(JSON.stringify(await run())) as Record<string, unknown>;
        expect(wire.state).toBe("failed");
        expect(wire).toHaveProperty("failedAt");
        expect(wire.failedAt).toBeNull();
    });

    it("failed: exposes no staleness verdict, because the row cannot support one", async () => {
        await resetLedger();
        await seedAnalysis();
        (await tryStartDataProfile(pool, ANALYSIS))._unsafeUnwrap();
        (await failDataProfile(pool, ANALYSIS, "Provider call failed for analysis:001 (HTTP 400): Bad Request"))._unsafeUnwrap();

        // The tool reads one ledger row; the analysis's current input set is the
        // embedder's knowledge. A field claiming that comparison would be constant.
        const wire = JSON.parse(JSON.stringify(await run())) as Record<string, unknown>;
        expect(Object.keys(wire).sort()).toEqual(["error", "failedAt", "message", "state"]);
        expect(tool.description).not.toContain("inputSetSinceFailure");
    });

    it("absent: carries no staleness verdict either — no producer keeps a comparand", async () => {
        await resetLedger();
        await seedAnalysis();
        (await tryStartDataProfile(pool, ANALYSIS))._unsafeUnwrap();
        (await completeDataProfile(pool, ANALYSIS))._unsafeUnwrap();

        const out = await run();
        expect(out.state).toBe("absent");
        expect(Object.keys(out).sort()).toEqual(["message", "state"]);
    });

    it("ready: a completed profile covering exactly the seeded inputs", async () => {
        await resetLedger();
        await seedAnalysis(["file-aaa", "file-bbb"]);
        await completeWith(makeResult());

        const out = await run();
        expect(out.state).toBe("ready");
        expect(out).not.toHaveProperty("staleReason");
    });

    it("stale: the input set changed after the profile was taken — the profile is still served", async () => {
        await resetLedger();
        // The seed names a third file the stored profile never covered.
        await seedAnalysis(["file-aaa", "file-bbb", "file-ccc"]);
        await completeWith(makeResult());

        const out = await run();
        expect(out.state).toBe("stale");
        expect(out).toMatchObject({ staleReason: expect.stringContaining("input file set changed") });
        // Stale is not empty: the content still comes back, because a stale profile beats none.
        expect(out).toMatchObject({ domain: "transcriptomics", describedFileCount: 2 });
    });

    it("stale: a re-profile is in flight over the prior result", async () => {
        await resetLedger();
        await seedAnalysis(["file-aaa", "file-bbb"]);
        await completeWith(makeResult());
        // `tryRerun` preserves data_profile_result on purpose — the prior profile stays servable.
        (await tryRerunDataProfile(pool, ANALYSIS))._unsafeUnwrap();

        const out = await run();
        expect(out.state).toBe("stale");
        expect(out).toMatchObject({ staleReason: expect.stringContaining("re-profile is in progress") });
        expect(out).toMatchObject({ summary: "Bulk RNA-seq of rectal biopsies, 24 samples." });
    });

    it("stale: the last attempt failed, but the prior profile survives and is served", async () => {
        await resetLedger();
        await seedAnalysis(["file-aaa", "file-bbb"]);
        await completeWith(makeResult());
        (await tryRerunDataProfile(pool, ANALYSIS))._unsafeUnwrap();
        (await failDataProfile(pool, ANALYSIS, "timeout"))._unsafeUnwrap();

        const out = await run();
        expect(out.state).toBe("stale");
        expect(out).toMatchObject({ staleReason: expect.stringContaining("timeout") });
        expect(out).toMatchObject({ describedFileCount: 2 });
        // A surviving result is served as `stale`, never as `failed` — which is why
        // the `failed` variant never has an input set to compare against.
        expect(out).not.toHaveProperty("failedAt");
    });
});

describe("scope: overview", () => {
    it("returns the orientation fields and the file count, not the file records", async () => {
        await resetLedger();
        await seedAnalysis();
        await completeWith(makeResult());

        const out = await run();
        expect(out).toMatchObject({
            state: "ready",
            scope: "overview",
            profiledAt: "2026-06-09T10:00:00.000Z",
            summary: "Bulk RNA-seq of rectal biopsies, 24 samples.",
            domain: "transcriptomics",
            subtype: "bulk-rna-seq",
            organism: { scientificName: "Homo sapiens", taxonId: "9606", source: "metadata", confidence: "high" },
            tissue: "rectal mucosal biopsy",
            cellType: "bulk tissue",
            condition: "Ulcerative Colitis vs healthy controls",
            accessions: ["GSE123456"],
            experimentalDesign: "12 UC vs 12 control, paired by batch.",
            qualityAssessment: { concerns: ["batch confounded with group"], strengths: ["balanced groups"] },
            describedFileCount: 2,
        });
        // The overview is an orientation, not a dump: per-file records live behind scope:"files".
        expect(out).not.toHaveProperty("files");
    });

    it("is the default scope", async () => {
        await resetLedger();
        await seedAnalysis();
        await completeWith(makeResult());

        expect(await run()).toMatchObject({ scope: "overview" });
        expect(await run({ scope: "overview" })).toMatchObject({ scope: "overview" });
    });

    it("serves a legacy collapsed profile without inventing the fields it lacks", async () => {
        await resetLedger();
        await seedAnalysis(["file-aaa"]);
        await completeWith({
            summary: "Three count matrices.",
            files: [{ path: "data/inputs/f1/counts.csv", description: "Raw counts" }],
            inputFileIds: ["file-aaa"],
            profiledAt: "2026-01-02T03:04:05.000Z",
        });

        const out = await run();
        expect(out).toMatchObject({ state: "ready", summary: "Three count matrices.", describedFileCount: 1, datasetFileCount: null, kindCount: null });
        // The widened fields come back undefined and drop out at JSON serialization —
        // the model is told nothing rather than told a default.
        const overview = out as { domain?: string; organism?: unknown; qualityAssessment?: unknown };
        expect(overview.domain).toBeUndefined();
        expect(overview.organism).toBeUndefined();
        expect(overview.qualityAssessment).toBeUndefined();
        expect(JSON.parse(JSON.stringify(out))).not.toHaveProperty("domain");
    });
});

describe("scope: files — paged, with truncation always visible", () => {
    it("returns the full per-file record, every widened field included", async () => {
        await resetLedger();
        await seedAnalysis();
        await completeWith(makeResult());

        const out = await run({ scope: "files" });
        expect(out).toMatchObject({ scope: "files", page: 1, pageSize: 20, total: 2, hasMore: false });
        expect(out).toMatchObject({
            files: [
                {
                    path: "data/inputs/f1/counts.csv",
                    description: "Raw count matrix",
                    dataType: "count-matrix",
                    format: "CSV",
                    rows: 20531,
                    cols: 24,
                    tags: ["counts"],
                    warnings: ["3 low-depth samples"],
                    metrics: { sparsity: 0.41 },
                },
                { path: "data/inputs/f2/metadata.csv", description: "Sample metadata", dataType: "clinical-metadata", format: "CSV", rows: 24, cols: 6 },
            ],
        });
    });

    it("reports total and hasMore truthfully across pages", async () => {
        await resetLedger();
        await seedAnalysis();
        await completeWith(filesResult(25));

        const first = await run({ scope: "files", page: 1, pageSize: 10 });
        expect(first).toMatchObject({ page: 1, pageSize: 10, total: 25, hasMore: true });
        expect((first as { files: unknown[] }).files).toHaveLength(10);

        const second = await run({ scope: "files", page: 2, pageSize: 10 });
        expect(second).toMatchObject({ page: 2, total: 25, hasMore: true });
        expect((second as { files: { path: string }[] }).files[0]?.path).toBe("data/inputs/f10/counts.csv");

        // The last page holds the remainder and says so — no silent truncation anywhere.
        const third = await run({ scope: "files", page: 3, pageSize: 10 });
        expect(third).toMatchObject({ page: 3, total: 25, hasMore: false });
        expect((third as { files: unknown[] }).files).toHaveLength(5);
    });

    it("a page past the end is empty and honest, not an error", async () => {
        await resetLedger();
        await seedAnalysis();
        await completeWith(filesResult(3));

        const out = await run({ scope: "files", page: 9, pageSize: 10 });
        expect(out).toMatchObject({ page: 9, total: 3, hasMore: false });
        expect((out as { files: unknown[] }).files).toHaveLength(0);
    });

    it("a profile that exactly fills one page reports hasMore: false", async () => {
        await resetLedger();
        await seedAnalysis();
        await completeWith(filesResult(10));

        expect(await run({ scope: "files", page: 1, pageSize: 10 })).toMatchObject({ total: 10, hasMore: false });
    });

    it("carries the staleness verdict onto the files scope too", async () => {
        await resetLedger();
        await seedAnalysis(["file-aaa", "file-bbb", "file-ccc"]);
        await completeWith(filesResult(3));

        expect(await run({ scope: "files" })).toMatchObject({ state: "stale", scope: "files", total: 3 });
    });
});

describe("scope: kinds", () => {
    /** A profile of 3513 files that describes one of them individually. */
    function structuredResult(): DataProfileResult {
        return makeResult({
            files: [{ path: "data/inputs/meta/samplesheet.csv", description: "Clinical annotations for all 1171 subjects." }],
            kinds: [
                {
                    name: "per-patient variant calls",
                    memberRepresents: "one patient's somatic variant calls",
                    description: "HaplotypeCaller VCFs.",
                    count: 1171,
                    pathPattern: "data/inputs/vcf/*.vcf.gz",
                    format: "vcf",
                    axisLabels: ["patient"],
                },
                {
                    name: "variant indexes",
                    memberRepresents: "the tabix index of one patient's calls",
                    description: "Tabix indexes.",
                    count: 1171,
                    pathPattern: "data/inputs/tbi/*.tbi",
                    format: "tabix-index",
                    axisLabels: ["patient"],
                },
            ],
            axes: [{ label: "patient", cardinality: 1171, exampleValues: ["PT0001", "PT0002"] }],
            coverage: { matched: 3510, unmatched: 3, total: 3513 },
        });
    }

    it("returns the dataset's structure with its counts, patterns, and axes", async () => {
        await resetLedger();
        await seedAnalysis();
        await completeWith(structuredResult());

        const out = await run({ scope: "kinds" });
        expect(out).toMatchObject({
            state: "ready",
            scope: "kinds",
            available: true,
            axes: [{ label: "patient", cardinality: 1171 }],
            coverage: { matched: 3510, unmatched: 3, total: 3513 },
        });
        expect((out as { kinds: unknown[] }).kinds).toHaveLength(2);
    });

    it("reports the scope unavailable — not empty — for a pre-kinds snapshot", async () => {
        await resetLedger();
        await seedAnalysis(["file-aaa"]);
        await completeWith({
            summary: "Three count matrices.",
            files: [{ path: "data/inputs/f1/counts.csv", description: "Raw counts" }],
            inputFileIds: ["file-aaa"],
            profiledAt: "2026-01-02T03:04:05.000Z",
        });

        const out = await run({ scope: "kinds" });
        expect(out).toMatchObject({ scope: "kinds", available: false });
        expect(out).not.toHaveProperty("kinds");
        expect((out as { message: string }).message).toContain("before the dataset-structure record existed");
    });

    it("does not let the described-file count masquerade as the dataset size", async () => {
        await resetLedger();
        await seedAnalysis();
        await completeWith(structuredResult());

        const out = await run();
        expect(out).toMatchObject({ describedFileCount: 1, datasetFileCount: 3513, kindCount: 2 });
        expect((out as { structureNote: string }).structureNote).toContain("scope:'kinds'");
    });

    it("states nothing about the dataset size a legacy row cannot support", async () => {
        await resetLedger();
        await seedAnalysis(["file-aaa"]);
        await completeWith({
            summary: "Legacy.",
            files: [{ path: "data/inputs/f1/counts.csv", description: "Raw counts" }],
            inputFileIds: ["file-aaa"],
            profiledAt: "2026-01-02T03:04:05.000Z",
        });

        const out = await run();
        expect(out).toMatchObject({ datasetFileCount: null, kindCount: null });
        expect((out as { structureNote: string }).structureNote).toContain("predates");
    });
});
