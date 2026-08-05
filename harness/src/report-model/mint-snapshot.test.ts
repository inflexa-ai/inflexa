import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { upsertArtifact, upsertArtifacts, type RegisterArtifactInput } from "../state/artifacts.js";
import { mintReportSnapshot } from "./mint-snapshot.js";

const ANALYSIS = "analysis-mint";

const DE_TABLE = "runs/run-1/step-1/output/de.csv";
const VOLCANO = "runs/run-1/step-1/figures/volcano.png";
const COUNTS = "data/inputs/file-1/counts.tsv";
const LATE_TABLE = "runs/run-2/step-1/output/enrichment.csv";

let pool: Pool;
let drop: () => Promise<void>;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("mint-snapshot"));
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

describe("mintReportSnapshot", () => {
    it("gives one entry for each registered artifact of each role, keyed by path", async () => {
        // The seed mixes the two roles on purpose. The snapshot states membership, thus the role of an
        // artifact never decides whether it is a member. A staged input is a member, the same as a step
        // output.
        await upsertArtifacts(pool, [
            artifact(DE_TABLE, "sha256:aaa", "output"),
            artifact(VOLCANO, "sha256:bbb", "figure"),
            artifact(COUNTS, "sha256:ccc", "output", "input"),
        ]);

        const snapshot = (await mintReportSnapshot(pool, ANALYSIS))._unsafeUnwrap();

        expect(Object.keys(snapshot.artifacts).sort()).toEqual([COUNTS, VOLCANO, DE_TABLE].sort());
        expect(snapshot.artifacts[DE_TABLE]).toEqual({ hash: "sha256:aaa", fileType: "output" });
        expect(snapshot.artifacts[VOLCANO]).toEqual({ hash: "sha256:bbb", fileType: "figure" });
        expect(snapshot.artifacts[COUNTS]).toEqual({ hash: "sha256:ccc", fileType: "output" });
    });

    it("gives an empty map and no error for an analysis with no registered artifact", async () => {
        // The seed belongs to a different analysis. Thus the empty answer comes from the scope of the
        // mint, and not from an empty table.
        await upsertArtifact(pool, artifact(DE_TABLE, "sha256:aaa", "output", "step_output", "analysis-other"));

        const result = await mintReportSnapshot(pool, ANALYSIS);

        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().artifacts).toEqual({});
    });

    it("holds no entry for an artifact that registers after the mint", async () => {
        await upsertArtifact(pool, artifact(DE_TABLE, "sha256:aaa", "output"));
        const earlier = (await mintReportSnapshot(pool, ANALYSIS))._unsafeUnwrap();

        await upsertArtifact(pool, artifact(LATE_TABLE, "sha256:ddd", "output"));

        expect(Object.keys(earlier.artifacts)).toEqual([DE_TABLE]);

        // The later mint proves that the row landed. Without it, the absence above could come from a
        // write that never happened.
        const later = (await mintReportSnapshot(pool, ANALYSIS))._unsafeUnwrap();
        expect(Object.keys(later.artifacts).sort()).toEqual([DE_TABLE, LATE_TABLE].sort());
    });

    it("keeps a path of `__proto__` an ordinary entry", async () => {
        // The ledger accepts any path. A plain object treats `__proto__` as the prototype setter, thus
        // the entry vanishes. The null-prototype map keeps the key an own member of the snapshot.
        await upsertArtifact(pool, artifact("__proto__", "sha256:eee", "output"));

        const snapshot = (await mintReportSnapshot(pool, ANALYSIS))._unsafeUnwrap();

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

        const snapshot = (await mintReportSnapshot(pool, ANALYSIS))._unsafeUnwrap();

        expect(snapshot.artifacts[DE_TABLE]).toEqual({ hash: "sha256:aaa", fileType: "output" });
    });

    it("copies no row into an entry", async () => {
        await upsertArtifact(pool, artifact(DE_TABLE, "sha256:aaa", "output"));

        const snapshot = (await mintReportSnapshot(pool, ANALYSIS))._unsafeUnwrap();

        const entry = snapshot.artifacts[DE_TABLE];
        expect(entry).toBeDefined();
        expect(Object.hasOwn(entry, "rows")).toBe(false);
        expect(entry.rows).toBeUndefined();
    });
});
