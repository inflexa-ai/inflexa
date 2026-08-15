import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { upsertArtifact, upsertArtifacts, type RegisterArtifactInput } from "../state/artifacts.js";
import { insertRun } from "../state/runs.js";
import { pinReportSnapshot } from "./pin-snapshot.js";

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
        await upsertArtifacts(pool, [
            artifact(DE_TABLE, "sha256:aaa", "output"),
            artifact(VOLCANO, "sha256:bbb", "figure"),
            artifact(COUNTS, "sha256:ccc", "output", "input"),
        ]);

        const snapshot = (await pinReportSnapshot(pool, ANALYSIS))._unsafeUnwrap();

        expect(Object.keys(snapshot.artifacts).sort()).toEqual([COUNTS, VOLCANO, DE_TABLE].sort());
        expect(snapshot.artifacts[DE_TABLE]).toEqual({ hash: "sha256:aaa", fileType: "output" });
        expect(snapshot.artifacts[VOLCANO]).toEqual({ hash: "sha256:bbb", fileType: "figure" });
        expect(snapshot.artifacts[COUNTS]).toEqual({ hash: "sha256:ccc", fileType: "output" });
    });

    it("gives an empty map and no error for an analysis with no registered artifact", async () => {
        // The seed belongs to a different analysis. Thus the empty answer comes from the scope of the
        // pin, and not from an empty table.
        await upsertArtifact(pool, artifact(DE_TABLE, "sha256:aaa", "output", "step_output", "analysis-other"));

        const result = await pinReportSnapshot(pool, ANALYSIS);

        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().artifacts).toEqual({});
    });

    it("holds no entry for an artifact that registers after the pin", async () => {
        await upsertArtifact(pool, artifact(DE_TABLE, "sha256:aaa", "output"));
        const earlier = (await pinReportSnapshot(pool, ANALYSIS))._unsafeUnwrap();

        await upsertArtifact(pool, artifact(LATE_TABLE, "sha256:ddd", "output"));

        expect(Object.keys(earlier.artifacts)).toEqual([DE_TABLE]);

        // The later pin proves that the row landed. Without it, the absence above could come from a
        // write that never happened.
        const later = (await pinReportSnapshot(pool, ANALYSIS))._unsafeUnwrap();
        expect(Object.keys(later.artifacts).sort()).toEqual([DE_TABLE, LATE_TABLE].sort());
    });

    it("keeps a path of `__proto__` an ordinary entry", async () => {
        // The ledger accepts any path. A plain object treats `__proto__` as the prototype setter, thus
        // the entry vanishes. The null-prototype map keeps the key an own member of the snapshot.
        await upsertArtifact(pool, artifact("__proto__", "sha256:eee", "output"));

        const snapshot = (await pinReportSnapshot(pool, ANALYSIS))._unsafeUnwrap();

        expect(Object.hasOwn(snapshot.artifacts, "__proto__")).toBe(true);
        expect(snapshot.artifacts["__proto__"]).toEqual({ hash: "sha256:eee", fileType: "output" });
    });

    it("keeps a row whose bytes are unrecoverable", async () => {
        await upsertArtifact(pool, artifact(DE_TABLE, "sha256:aaa", "output"));
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
        await upsertArtifact(pool, artifact(DE_TABLE, "sha256:aaa", "output"));

        const snapshot = (await pinReportSnapshot(pool, ANALYSIS))._unsafeUnwrap();

        const entry = snapshot.artifacts[DE_TABLE];
        expect(entry).toBeDefined();
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
    function resolveRoot(): string {
        return root;
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

    it("fails the pin when the run listing fails", async () => {
        await seedRun("run-1");
        // A store fault is not absence. The dropped table makes the listing fail against a real driver
        // error, thus the pin refuses instead of writing an empty citation list.
        await pool.query("DROP TABLE cortex_runs");

        const result = await pinReportSnapshot(pool, ANALYSIS, { resolveWorkspaceRoot: resolveRoot });

        expect(result.isErr()).toBe(true);
        expect(result._unsafeUnwrapErr().kind).toBe("run-listing-failed");
    });
});
