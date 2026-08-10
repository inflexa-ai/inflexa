/**
 * The pin of a report snapshot, which is the membership boundary of one report session.
 *
 * A report session freezes at one moment, and the analysis continues after that anchor. The snapshot
 * states which artifacts existed at the anchor, and that is a question that no other record answers.
 * Thus a session never cites an artifact that a later run produced.
 *
 * The artifact ledger holds one row for each path, and it keeps no history. Thus the set at a past
 * moment is not recoverable later, and the pin must run at the anchor itself.
 */

import { err, ok, type Result } from "neverthrow";

import { queryAnalysisArtifacts, type AnalysisArtifactRef } from "../state/artifacts.js";
import type { Querier } from "../state/db.js";
import type { ArtifactSnapshot, ReportSnapshot } from "./reference-resolver.js";

/**
 * The reason that the pin gave no snapshot. The read of the ledger is the one operation that can
 * fail. An analysis with no registered artifact is a normal answer, thus absence is not a member of
 * this set. `cause` carries the underlying fault for a log.
 */
export type PinSnapshotError = {
    kind: "ledger-read-failed";
    cause: unknown;
};

/**
 * Pin the snapshot of one analysis from the artifact ledger.
 *
 * The pin copies no cell and no byte. An entry pins identity alone, thus the snapshot grows with the
 * count of artifacts and never with the size of the data. A read of an artifact belongs to the value
 * tier, which runs one time for each report version.
 */
export async function pinReportSnapshot(pool: Querier, analysisId: string): Promise<Result<ReportSnapshot, PinSnapshotError>> {
    let ledgerRows: AnalysisArtifactRef[];
    try {
        ledgerRows = await queryAnalysisArtifacts(pool, analysisId);
    } catch (cause) {
        // The query speaks the throw protocol of the `pg` driver. This is the thin wrapper that turns
        // that throw into a value, thus each caller above reads a failure as data.
        return err({ kind: "ledger-read-failed", cause });
    }

    // The ledger accepts any path. A null-prototype map keeps a key such as `__proto__` an ordinary
    // entry, thus no path collides with a prototype slot.
    const artifacts: Record<string, ArtifactSnapshot> = Object.create(null);
    for (const row of ledgerRows) {
        artifacts[row.path] = { hash: row.hash, fileType: row.fileType };
    }

    // The pin fills no citation. No store holds the citation ids of an analysis, and validation
    // matches a citation against the external authorities and never against a pinned list. Thus such
    // a list would state nothing that a later read consumes.
    return ok({ artifacts });
}
