/**
 * The pin of a report snapshot, which is the membership boundary of one report session.
 *
 * A report session freezes at one moment, and the analysis continues after that anchor. The snapshot
 * states which artifacts existed at the anchor, and that is a question that no other record answers.
 * Thus a session never cites an artifact that a later run produced.
 *
 * The artifact ledger holds one row for each path, and it keeps no history. Thus the set at a past
 * moment is not recoverable later, and the pin must run at the anchor itself.
 *
 * The snapshot carries the citation evidence beside the artifact map. The key references of a run
 * synthesis are the papers that the analysis engaged, and they live in the run tree on disk. Thus the
 * pin reads that tree through the workspace-root seam of the caller.
 */

import { err, ok, type Result } from "neverthrow";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { tryFs } from "../lib/fs-result.js";
import { queryAnalysisArtifacts, type AnalysisArtifactRef } from "../state/artifacts.js";
import type { Querier } from "../state/db.js";
import { queryRunsByAnalysis } from "../state/runs.js";
import { isSafeId, runDir, type ResolveWorkspaceRoot } from "../workspace/paths.js";
import type { ArtifactSnapshot, ReportSnapshot } from "./reference-resolver.js";

/**
 * The reason that the pin gave no snapshot. The ledger read and the run listing are the two operations
 * that can fail. An analysis with no registered artifact and an analysis with no synthesis on disk are
 * normal answers, thus absence is not a member of this set. `cause` carries the underlying fault for a
 * log.
 */
export type PinSnapshotError = {
    kind: "ledger-read-failed" | "run-listing-failed";
    cause: unknown;
};

/** The construction options of the pin. */
export interface PinReportSnapshotOptions {
    /**
     * The workspace-root seam of the caller. The citation evidence sits on disk, thus a composition
     * that binds no seam pins the artifact map alone.
     */
    readonly resolveWorkspaceRoot?: ResolveWorkspaceRoot;
}

/** The file name of the synthesis record inside the run directory. */
const SYNTHESIS_FILE = "synthesis.json";

/**
 * The cap of one synthesis read. A synthesis record is small by construction, and the cap bounds the
 * cost of a file that is not. A file over the cap gives no key, because a cut JSON text cannot parse.
 */
const SYNTHESIS_CAP_BYTES = 1024 * 1024;

/** The page size of the run listing. The listing walks the pages until a short page ends the walk. */
const RUN_PAGE_SIZE = 200;

/**
 * Read a synthesis record under the cap, or give `undefined` when the bytes do not come back.
 *
 * The read takes a bounded byte window, thus a file of any size costs the cap. An absent file, a genuine
 * read fault, and a file over the cap each give `undefined`, because the collection reports no error for
 * one record.
 */
async function readSynthesisText(absolute: string): Promise<string | undefined> {
    return tryFs<string | undefined>(
        "pinReportSnapshot.readSynthesis",
        async () => {
            const handle = await open(absolute, "r");
            try {
                // The window takes one byte more than the cap. A read that fills it states that the file
                // holds more bytes than the cap admits, thus the two conditions stay apart.
                const buffer = Buffer.alloc(SYNTHESIS_CAP_BYTES + 1);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                return bytesRead > SYNTHESIS_CAP_BYTES ? undefined : buffer.subarray(0, bytesRead).toString("utf8");
            } finally {
                await handle.close();
            }
        },
        { path: absolute, onAbsent: () => undefined },
    ).unwrapOr(undefined);
}

/**
 * The citation keys of one synthesis text.
 *
 * The extraction is lenient: it parses the JSON and it takes each `keyReferences` PMID that is a
 * non-empty string. A whole-schema parse would empty the citation list of the whole analysis for one
 * record that a different schema version wrote. Malformed JSON gives no key.
 */
function citationKeysOf(text: string): string[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return [];
    }
    if (typeof parsed !== "object" || parsed === null) {
        return [];
    }
    const references = (parsed as { keyReferences?: unknown }).keyReferences;
    if (!Array.isArray(references)) {
        return [];
    }
    const keys: string[] = [];
    for (const reference of references) {
        if (typeof reference !== "object" || reference === null) {
            continue;
        }
        const pmid = (reference as { pmid?: unknown }).pmid;
        if (typeof pmid !== "string") {
            continue;
        }
        const id = pmid.trim();
        if (id.length > 0) {
            keys.push(`pmid:${id}`);
        }
    }
    return keys;
}

/**
 * Collect the citation evidence of one analysis from the synthesis record of each of its runs.
 *
 * The keys dedupe, and they sort in code-unit order. Thus one disk state gives one list, and a second
 * pin over that state gives the same list.
 *
 * A run listing that fails fails the collection, because a store fault is not absence. Each other fault
 * is a normal condition: an unresolvable workspace root, an absent record, an unreadable record, and a
 * malformed record each give no key and no error.
 */
export async function collectCitationKeys(
    pool: Querier,
    resolveWorkspaceRoot: ResolveWorkspaceRoot,
    analysisId: string,
): Promise<Result<string[], PinSnapshotError>> {
    let root: string;
    try {
        root = resolveWorkspaceRoot(analysisId);
    } catch {
        // The seam signals an unresolvable resource by a throw. The artifact map still states the
        // membership of the session, thus the fault costs the citation list alone.
        return ok([]);
    }

    const keys = new Set<string>();
    for (let offset = 0; ; offset += RUN_PAGE_SIZE) {
        const page = await queryRunsByAnalysis(pool, analysisId, { limit: RUN_PAGE_SIZE, offset });
        if (page.isErr()) {
            return err({ kind: "run-listing-failed", cause: page.error.cause });
        }
        for (const run of page.value) {
            // The path builder refuses an id that can escape the run tree. A refusal is a throw, thus
            // the guard keeps the collection on the value channel.
            if (!isSafeId(run.runId)) {
                continue;
            }
            const text = await readSynthesisText(join(root, runDir(run.runId), SYNTHESIS_FILE));
            if (text === undefined) {
                continue;
            }
            for (const key of citationKeysOf(text)) {
                keys.add(key);
            }
        }
        if (page.value.length < RUN_PAGE_SIZE) {
            return ok([...keys].sort());
        }
    }
}

/**
 * Pin the snapshot of one analysis from the artifact ledger and from the synthesis records of its runs.
 *
 * The pin copies no cell and no byte. An entry pins identity alone, thus the snapshot grows with the
 * count of artifacts and never with the size of the data. A read of an artifact belongs to the value
 * tier, which runs one time for each report version.
 */
export async function pinReportSnapshot(
    pool: Querier,
    analysisId: string,
    options: PinReportSnapshotOptions = {},
): Promise<Result<ReportSnapshot, PinSnapshotError>> {
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

    // A citation reference resolves against this list: the resolver refuses a key that the list does not
    // hold. Thus the pin must state which external ids the analysis engaged, and a session with an empty
    // list can bind no citation block.
    if (options.resolveWorkspaceRoot === undefined) {
        return ok({ artifacts, citations: [] });
    }
    const citations = await collectCitationKeys(pool, options.resolveWorkspaceRoot, analysisId);
    return citations.map((keys) => ({ artifacts, citations: keys }));
}
