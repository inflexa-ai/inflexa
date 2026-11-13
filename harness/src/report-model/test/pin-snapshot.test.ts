import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";

import type { CitationReference } from "../../contracts/report-reference.js";
import { withSchema } from "../../__tests__/setup/postgres.js";
import { upsertArtifact, upsertArtifacts, type RegisterArtifactInput } from "../../state/artifacts.js";
import { upsertAnalysis } from "../../state/analyses.js";
import { insertPlan } from "../../state/plans.js";
import { insertRun } from "../../state/runs.js";
import { createFixtureResolver } from "../fixture-resolver.js";
import { pinReportSnapshot } from "../pin-snapshot.js";
import type { CitationRecords } from "../reference-resolver.js";
import { stepDecisionRecordDir } from "../../workspace/paths.js";

const ANALYSIS = "analysis-pin";

const DE_TABLE = "runs/run-1/step-1/output/de.csv";
const VOLCANO = "runs/run-1/step-1/figures/volcano.png";
const COUNTS = "data/inputs/file-1/counts.tsv";
const LATE_TABLE = "runs/run-2/step-1/output/enrichment.csv";

let pool: Pool;
let drop: () => Promise<void>;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("pin-snapshot"));
});

afterEach(async () => {
    await drop();
});

function artifact(
    path: string,
    hash: string,
    fileType: string,
    role: RegisterArtifactInput["role"] = "step_output",
    analysisId: string = ANALYSIS,
): RegisterArtifactInput {
    return { resourceId: analysisId, path, hash, size: 128, role, fileType };
}

describe("pinReportSnapshot", () => {
    it("gives one entry for each registered artifact of each role, keyed by path", async () => {
        // The seed mixes the two roles on purpose. The snapshot states membership, thus the role of an
        // artifact never decides whether it is a member. A staged input is a member, the same as a step
        // output.
        (
            await upsertArtifacts(pool, [
                artifact(DE_TABLE, "sha256:aaa", "output"),
                artifact(VOLCANO, "sha256:bbb", "figure"),
                artifact(COUNTS, "sha256:ccc", "output", "input"),
            ])
        )._unsafeUnwrap();

        const snapshot = (await pinReportSnapshot(pool, ANALYSIS))._unsafeUnwrap();

        expect(Object.keys(snapshot.artifacts).sort()).toEqual([COUNTS, VOLCANO, DE_TABLE].sort());
        expect(snapshot.artifacts[DE_TABLE]).toEqual({ hash: "sha256:aaa", fileType: "output" });
        expect(snapshot.artifacts[VOLCANO]).toEqual({ hash: "sha256:bbb", fileType: "figure" });
        expect(snapshot.artifacts[COUNTS]).toEqual({ hash: "sha256:ccc", fileType: "output" });
    });

    it("gives an empty map and no error for an analysis with no registered artifact", async () => {
        // The seed belongs to a different analysis. Thus the empty answer comes from the scope of the
        // pin, and not from an empty table.
        (await upsertArtifact(pool, artifact(DE_TABLE, "sha256:aaa", "output", "step_output", "analysis-other")))._unsafeUnwrap();

        const result = await pinReportSnapshot(pool, ANALYSIS);

        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().artifacts).toEqual({});
    });

    it("holds no entry for an artifact that registers after the pin", async () => {
        (await upsertArtifact(pool, artifact(DE_TABLE, "sha256:aaa", "output")))._unsafeUnwrap();
        const earlier = (await pinReportSnapshot(pool, ANALYSIS))._unsafeUnwrap();

        (await upsertArtifact(pool, artifact(LATE_TABLE, "sha256:ddd", "output")))._unsafeUnwrap();

        expect(Object.keys(earlier.artifacts)).toEqual([DE_TABLE]);

        // The later pin proves that the row landed. Without it, the absence above could come from a
        // write that never happened.
        const later = (await pinReportSnapshot(pool, ANALYSIS))._unsafeUnwrap();
        expect(Object.keys(later.artifacts).sort()).toEqual([DE_TABLE, LATE_TABLE].sort());
    });

    it("keeps a path of `__proto__` an ordinary entry", async () => {
        // The ledger accepts any path. A plain object treats `__proto__` as the prototype setter, thus
        // the entry vanishes. The null-prototype map keeps the key an own member of the snapshot.
        (await upsertArtifact(pool, artifact("__proto__", "sha256:eee", "output")))._unsafeUnwrap();

        const snapshot = (await pinReportSnapshot(pool, ANALYSIS))._unsafeUnwrap();

        expect(Object.hasOwn(snapshot.artifacts, "__proto__")).toBe(true);
        expect(snapshot.artifacts["__proto__"]).toEqual({ hash: "sha256:eee", fileType: "output" });
    });

    it("keeps a row whose bytes are unrecoverable", async () => {
        (await upsertArtifact(pool, artifact(DE_TABLE, "sha256:aaa", "output")))._unsafeUnwrap();
        const marked = await pool.query("UPDATE cortex_artifacts SET unrecoverable_at = $1 WHERE analysis_id = $2 AND path = $3", [
            new Date().toISOString(),
            ANALYSIS,
            DE_TABLE,
        ]);
        expect(marked.rowCount).toBe(1);

        const snapshot = (await pinReportSnapshot(pool, ANALYSIS))._unsafeUnwrap();

        expect(snapshot.artifacts[DE_TABLE]).toEqual({ hash: "sha256:aaa", fileType: "output" });
    });

    it("copies no row into an entry", async () => {
        (await upsertArtifact(pool, artifact(DE_TABLE, "sha256:aaa", "output")))._unsafeUnwrap();

        const snapshot = (await pinReportSnapshot(pool, ANALYSIS))._unsafeUnwrap();

        const entry = snapshot.artifacts[DE_TABLE];
        if (entry === undefined) throw new Error("the snapshot holds no entry for the derived table");
        expect(Object.hasOwn(entry, "rows")).toBe(false);
        expect(entry.rows).toBeUndefined();
    });
});

describe("the citation evidence of the pin", () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "pin-citations-"));
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    /** The seam of the test. One analysis maps onto the one temporary tree. */
    function resolveRoot(): Promise<string> {
        return Promise.resolve(root);
    }

    async function seedRun(runId: string): Promise<void> {
        (await insertRun(pool, { runId, analysisId: ANALYSIS, workflowName: "executeAnalysis" }))._unsafeUnwrap();
    }

    /** Write the synthesis record of a run as raw text, thus a test can write a record that no schema admits. */
    async function writeSynthesis(runId: string, text: string): Promise<void> {
        const dir = join(root, "runs", runId);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "synthesis.json"), text, "utf8");
    }

    async function pinCitations(): Promise<string[] | undefined> {
        const snapshot = (await pinReportSnapshot(pool, ANALYSIS, { resolveWorkspaceRoot: resolveRoot }))._unsafeUnwrap();
        return snapshot.citations;
    }

    async function pinCitationRecords(): Promise<CitationRecords | undefined> {
        const snapshot = (await pinReportSnapshot(pool, ANALYSIS, { resolveWorkspaceRoot: resolveRoot }))._unsafeUnwrap();
        return snapshot.citationRecords;
    }

    it("gives one `pmid:` key for each key reference of a run synthesis", async () => {
        await seedRun("run-1");
        await writeSynthesis(
            "run-1",
            JSON.stringify({
                runId: "run-1",
                keyReferences: [
                    { pmid: "12345", citation: "Smith 2020", description: "The primary paper." },
                    { pmid: " 987 ", citation: "Jones 2019", description: "The second paper." },
                ],
            }),
        );

        // The trim of the second id proves that the key carries the id alone.
        expect(await pinCitations()).toEqual(["pmid:12345", "pmid:987"]);
    });

    it("gives one `pmid:` key for each reference of a finding", async () => {
        await seedRun("run-findings");
        // The record names the paper in the references of a finding alone. That field carries the
        // superset of the literature that the synthesis engaged, thus a citation over it must resolve.
        await writeSynthesis(
            "run-findings",
            JSON.stringify({
                findings: [
                    { stepId: "step-1", references: [{ pmid: "31234", citation: "Smith 2020" }, { pmid: " 4567 " }] },
                    { stepId: "step-2", references: [{ pmid: "" }, { pmid: 42 }, "text", {}] },
                    "not-an-object",
                ],
                keyReferences: [],
            }),
        );

        expect(await pinCitations()).toEqual(["pmid:31234", "pmid:4567"]);
    });

    it("dedupes one paper that both fields of a record name", async () => {
        await seedRun("run-both");
        await writeSynthesis(
            "run-both",
            JSON.stringify({
                findings: [{ references: [{ pmid: "12345" }, { pmid: "678" }] }],
                keyReferences: [{ pmid: "12345", citation: "Smith 2020" }],
            }),
        );

        expect(await pinCitations()).toEqual(["pmid:12345", "pmid:678"]);
    });

    it("dedupes one paper across two runs and sorts the keys in code-unit order", async () => {
        await seedRun("run-a");
        await seedRun("run-b");
        await writeSynthesis("run-a", JSON.stringify({ keyReferences: [{ pmid: "999" }, { pmid: "12345" }] }));
        await writeSynthesis("run-b", JSON.stringify({ keyReferences: [{ pmid: "12345" }, { pmid: "42" }] }));

        expect(await pinCitations()).toEqual(["pmid:12345", "pmid:42", "pmid:999"]);
    });

    it("takes the key references of a record that no whole schema admits", async () => {
        await seedRun("run-legacy");
        // The record carries the key references and no other field. A whole-schema parse would refuse it,
        // and the citation list of the analysis would then hold nothing.
        await writeSynthesis("run-legacy", JSON.stringify({ keyReferences: [{ pmid: "555" }] }));

        expect(await pinCitations()).toEqual(["pmid:555"]);
    });

    it("drops a key reference whose pmid is empty or is not a string", async () => {
        await seedRun("run-thin");
        await writeSynthesis("run-thin", JSON.stringify({ keyReferences: [{ pmid: "   " }, { pmid: 42 }, {}, "text", { pmid: "77" }] }));

        expect(await pinCitations()).toEqual(["pmid:77"]);
    });

    it("gives no key and no error for a run that holds no synthesis record", async () => {
        await seedRun("run-bare");

        const result = await pinReportSnapshot(pool, ANALYSIS, { resolveWorkspaceRoot: resolveRoot });

        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().citations).toEqual([]);
    });

    it("gives no key and no error for a malformed record", async () => {
        await seedRun("run-broken");
        await writeSynthesis("run-broken", "{ this is not json");

        const result = await pinReportSnapshot(pool, ANALYSIS, { resolveWorkspaceRoot: resolveRoot });

        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().citations).toEqual([]);
    });

    it("gives no key for a record over the read cap", async () => {
        await seedRun("run-huge");
        // The record parses, but its bytes pass 1 MiB. A cut text cannot parse, thus the read gives none.
        await writeSynthesis("run-huge", JSON.stringify({ keyReferences: [{ pmid: "12345", description: "x".repeat(1024 * 1024 + 64) }] }));

        const result = await pinReportSnapshot(pool, ANALYSIS, { resolveWorkspaceRoot: resolveRoot });

        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().citations).toEqual([]);
    });

    it("pins no citation when the composition gives no workspace-root seam", async () => {
        await seedRun("run-1");
        await writeSynthesis("run-1", JSON.stringify({ keyReferences: [{ pmid: "12345" }] }));

        const snapshot = (await pinReportSnapshot(pool, ANALYSIS))._unsafeUnwrap();

        expect(snapshot.citations).toEqual([]);
    });

    it("resolves a citation reference over a pinned synthesis pmid", async () => {
        await seedRun("run-agree");
        await writeSynthesis("run-agree", JSON.stringify({ keyReferences: [{ pmid: "31234", citation: "Smith 2020" }] }));

        const snapshot = (await pinReportSnapshot(pool, ANALYSIS, { resolveWorkspaceRoot: resolveRoot }))._unsafeUnwrap();
        const reference: CitationReference = { kind: "citation", idKind: "pmid", id: "31234", raw: "Smith 2020" };
        const resolved = await createFixtureResolver().resolve(reference, snapshot);

        // The pin writes the key, and the resolver reads it. One test over the two sides locks the shape
        // of the key, thus a change on one side alone fails here and not at a session of a user.
        expect(resolved._unsafeUnwrap()).toEqual({ type: "citation", id: "pmid:31234" });
    });

    it("stores the citation and the description of a key reference beside its key", async () => {
        await seedRun("run-record");
        await writeSynthesis(
            "run-record",
            JSON.stringify({
                keyReferences: [
                    { pmid: "26997480", citation: " Hugo et al. 2016 ", description: "The resistance paper." },
                    { pmid: "999", citation: "Roe 2021" },
                ],
            }),
        );

        // The trim of the citation proves that the record carries the text alone. A reference with no
        // description stores the citation on its own.
        expect(await pinCitationRecords()).toEqual({
            "pmid:26997480": { citation: "Hugo et al. 2016", description: "The resistance paper." },
            "pmid:999": { citation: "Roe 2021" },
        });
    });

    it("keeps the record of the key reference when a finding names the same paper", async () => {
        await seedRun("run-duplicate");
        // The finding reference carries the narrower relevance text, and the key reference carries the
        // curated description. The key references walk first, thus the curated record survives.
        await writeSynthesis(
            "run-duplicate",
            JSON.stringify({
                findings: [{ references: [{ pmid: "12345", citation: "Smith 2020 (finding)", relevance: "It supports the finding." }] }],
                keyReferences: [{ pmid: "12345", citation: "Smith 2020", description: "The primary paper." }],
            }),
        );

        expect(await pinCitationRecords()).toEqual({ "pmid:12345": { citation: "Smith 2020", description: "The primary paper." } });
    });

    it("stores the citation of a finding reference that no key reference names", async () => {
        await seedRun("run-finding-record");
        await writeSynthesis(
            "run-finding-record",
            JSON.stringify({
                findings: [{ references: [{ pmid: "31234", citation: "Doe 2019", relevance: "It contextualizes the finding." }] }],
                keyReferences: [],
            }),
        );

        // The relevance text is not the description of the paper, thus the record carries the citation
        // alone.
        expect(await pinCitationRecords()).toEqual({ "pmid:31234": { citation: "Doe 2019" } });
    });

    it("stores no map when no reference carries a citation text", async () => {
        await seedRun("run-bare-keys");
        await writeSynthesis("run-bare-keys", JSON.stringify({ keyReferences: [{ pmid: "12345" }, { pmid: "999", citation: "   " }] }));

        // The keys still pin, thus a citation block over either one resolves. A stored pin with no map
        // reads the same as a pin that predates the map.
        expect(await pinCitations()).toEqual(["pmid:12345", "pmid:999"]);
        expect(await pinCitationRecords()).toBeUndefined();
    });

    /** A run of a plan whose step `T1S2` cites one claim, and whose claim view holds one DOI in upper case. */
    async function seedGroundedRun(runId: string): Promise<void> {
        (await upsertAnalysis(pool, ANALYSIS, null))._unsafeUnwrap();
        const planId = (
            await insertPlan(pool, {
                analysisId: ANALYSIS,
                plan: {
                    steps: [
                        { id: "T1S2", grounding: { status: "grounded", snapshot: "sha256:71ac", claims: ["R-0028@d560"], reason: "edgeR per R-0028" } },
                        { id: "T1S3" },
                    ],
                    claims: [
                        {
                            id: "R-0028@d560",
                            snapshot: "sha256:71ac",
                            title: "Use the quasi-likelihood F-test",
                            statement: "s",
                            strength: "consensus",
                            evidence: [{ doi: "10.1093/BIOINFORMATICS/btw014", title: "edgeR QL", year: 2016, direction: "supports" }],
                        },
                    ],
                },
            })
        )._unsafeUnwrap();
        (await insertRun(pool, { runId, analysisId: ANALYSIS, workflowName: "executeAnalysis", planId }))._unsafeUnwrap();
    }

    async function writeDecisionRecord(runId: string, stepId: string, record: unknown): Promise<void> {
        const dir = stepDecisionRecordDir({ workspaceRoot: root, runId, stepId });
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "decision_record_tpl.json"), JSON.stringify(record), "utf8");
    }

    it("pins each DOI and PubMed id of the methods of a run, also with no synthesis", async () => {
        await seedGroundedRun("run-methods");
        await writeDecisionRecord("run-methods", "T1S3", {
            template: { id: "tpl-reproducibility-record", version: "1.1.0", label: "Record", method: { id: "M-0090", label: "Record" } },
            citations: [
                { pmid: "19910308", title: "edgeR: a Bioconductor package", year: 2010 },
                { url: "https://example.org/manual", title: "A manual" },
            ],
        });

        // The claim view of T1S2 gives the DOI in lower case, and the record of T1S3 gives the PubMed id.
        // A source with a URL alone has no citation key.
        expect(await pinCitations()).toEqual(["doi:10.1093/bioinformatics/btw014", "pmid:19910308"]);
        expect(await pinCitationRecords()).toEqual({
            "doi:10.1093/bioinformatics/btw014": { citation: "edgeR QL (2016)" },
            "pmid:19910308": { citation: "edgeR: a Bioconductor package (2010)" },
        });
    });

    it("pins each source of a step past the bound of the methods display list", async () => {
        await seedGroundedRun("run-many-sources");
        const citations = Array.from({ length: 70 }, (_, i) => ({ pmid: String(1000 + i), title: `Paper ${i}` }));
        await writeDecisionRecord("run-many-sources", "T1S3", {
            template: { id: "tpl-reproducibility-record", version: "1.1.0", label: "Record", method: { id: "M-0090", label: "Record" } },
            citations,
        });

        expect(await pinCitations()).toContain("pmid:1069");
    });

    it("pins each method reference of a run synthesis, and keeps its citation", async () => {
        await seedRun("run-method-refs");
        await writeSynthesis(
            "run-method-refs",
            JSON.stringify({
                keyReferences: [],
                methodReferences: [
                    { stepId: "T1S2", source: "doi:10.1093/Bioinformatics/btp616", citation: "Robinson 2010", method: "edgeR" },
                    { stepId: "T1S2", source: "url:https://example.org", citation: "A page", method: "edgeR" },
                    { stepId: "T1S2", source: "doi:", citation: "Nothing", method: "edgeR" },
                ],
            }),
        );

        expect(await pinCitations()).toEqual(["doi:10.1093/bioinformatics/btp616"]);
        expect(await pinCitationRecords()).toEqual({ "doi:10.1093/bioinformatics/btp616": { citation: "Robinson 2010" } });
    });

    it("resolves a DOI citation that an author types in a different case", async () => {
        await seedGroundedRun("run-doi");

        const snapshot = (await pinReportSnapshot(pool, ANALYSIS, { resolveWorkspaceRoot: resolveRoot }))._unsafeUnwrap();
        const reference: CitationReference = {
            kind: "citation",
            idKind: "doi",
            id: "10.1093/Bioinformatics/BTW014",
            raw: "Lun 2016",
            assert: { value: "doi:10.1093/BIOINFORMATICS/btw014" },
        };
        const resolved = await createFixtureResolver().resolve(reference, snapshot);

        expect(resolved._unsafeUnwrap()).toEqual({ type: "citation", id: "doi:10.1093/bioinformatics/btw014" });
    });

    it("fails the pin when the plan read of a run fails", async () => {
        await seedGroundedRun("run-plan-fault");
        // The same fault shape as the run listing below: a table with no columns gives a real driver error.
        await pool.query("ALTER TABLE cortex_runs DROP CONSTRAINT IF EXISTS cortex_runs_plan_id_fkey");
        await pool.query("DROP TABLE cortex_plans CASCADE");
        await pool.query("CREATE TABLE cortex_plans ()");

        const result = await pinReportSnapshot(pool, ANALYSIS, { resolveWorkspaceRoot: resolveRoot });

        expect(result.isErr()).toBe(true);
        expect(result._unsafeUnwrapErr().kind).toBe("plan-read-failed");
    });

    it("fails the pin when the run listing fails", async () => {
        await seedRun("run-1");
        // A store fault is not absence. A table with no columns makes the listing fail against a real driver
        // error, thus the pin refuses instead of writing an empty citation list. A plain drop is not enough:
        // the search path of the test schema ends at `public`, which can hold a `cortex_runs` that answers.
        await pool.query("DROP TABLE cortex_runs");
        await pool.query("CREATE TABLE cortex_runs ()");

        const result = await pinReportSnapshot(pool, ANALYSIS, { resolveWorkspaceRoot: resolveRoot });

        expect(result.isErr()).toBe(true);
        expect(result._unsafeUnwrapErr().kind).toBe("run-listing-failed");
    });
});
