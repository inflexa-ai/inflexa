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
 * The snapshot carries the citation evidence beside the artifact map. The pinned set is the literature
 * that the synthesis engaged, and two fields of a run synthesis carry it: the key references and the
 * references of each finding. The records live in the run tree on disk. Thus the pin reads that tree
 * through the workspace-root seam of the caller.
 *
 * A reference that carries a short citation also pins a bibliography record beside its key. The key list
 * keeps the membership role, thus the record map is optional and it changes no resolution.
 */

import { err, ok, type Result } from "neverthrow";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { tryFs } from "../lib/fs-result.js";
import { queryAnalysisArtifacts, type AnalysisArtifactRef } from "../state/artifacts.js";
import type { Querier } from "../state/db.js";
import { queryRunsByAnalysis } from "../state/runs.js";
import { isSafeId, runDir, type ResolveWorkspaceRoot } from "../workspace/paths.js";
import type { ArtifactSnapshot, CitationRecord, ReportSnapshot } from "./reference-resolver.js";

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
                // One read of a network-backed file can give fewer bytes than the window holds. Such a
                // short read cuts the text in the middle of the JSON, and the record then parses to no
                // key at all. Thus the loop reads again from the offset that the last read reached, and
                // it stops when the window fills or when a read gives no byte.
                let filled = 0;
                while (filled < buffer.length) {
                    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
                    if (bytesRead === 0) {
                        break;
                    }
                    filled += bytesRead;
                }
                return filled > SYNTHESIS_CAP_BYTES ? undefined : buffer.subarray(0, filled).toString("utf8");
            } finally {
                await handle.close();
            }
        },
        { path: absolute, onAbsent: () => undefined },
    ).unwrapOr(undefined);
}

/** One citation of a synthesis record: the key, and the bibliography record when the entry carries one. */
interface CitationEntry {
    readonly key: string;
    readonly record?: CitationRecord;
}

/** The trimmed text of a field, or `undefined` when the field is not a non-empty string. */
function trimmedText(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const text = value.trim();
    return text.length > 0 ? text : undefined;
}

/**
 * The bibliography record of one reference entry, or `undefined` when the entry carries no citation text.
 *
 * A key reference carries `citation` and `description`. A reference of a finding carries `citation` and a
 * narrower `relevance`, thus it gives the short citation alone. A record without a citation would state
 * nothing, thus such an entry gives a bare key.
 */
function recordOf(reference: { citation?: unknown; description?: unknown }): CitationRecord | undefined {
    const citation = trimmedText(reference.citation);
    if (citation === undefined) {
        return undefined;
    }
    const description = trimmedText(reference.description);
    return description === undefined ? { citation } : { citation, description };
}

/**
 * Take one `pmid:` citation from each entry of one reference list, and add it to `entries`.
 *
 * The walk is lenient: a value that is not a list, an entry that is not an object, and a PMID that is
 * not a non-empty string each give no citation.
 */
function pushPmidCitations(list: unknown, entries: CitationEntry[]): void {
    if (!Array.isArray(list)) {
        return;
    }
    for (const reference of list) {
        if (typeof reference !== "object" || reference === null) {
            continue;
        }
        const pmid = (reference as { pmid?: unknown }).pmid;
        if (typeof pmid !== "string") {
            continue;
        }
        const id = pmid.trim();
        if (id.length > 0) {
            const record = recordOf(reference as { citation?: unknown; description?: unknown });
            entries.push(record === undefined ? { key: `pmid:${id}` } : { key: `pmid:${id}`, record });
        }
    }
}

/**
 * The citations of one synthesis text, in the order that the record carries them.
 *
 * The extraction is lenient: it parses the JSON, and it takes each PMID of `keyReferences` and of the
 * references of each finding. The key references are the papers that the synthesis names as primary, and
 * the references of the findings are the superset. Thus a citation over either one resolves. A
 * whole-schema parse would empty the citation list of the whole analysis for one record that a different
 * schema version wrote. Malformed JSON gives no citation.
 *
 * The key references come first, because the caller keeps the first record of a key and the curated
 * description sits there.
 */
function citationsOf(text: string): CitationEntry[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return [];
    }
    if (typeof parsed !== "object" || parsed === null) {
        return [];
    }
    const entries: CitationEntry[] = [];
    pushPmidCitations((parsed as { keyReferences?: unknown }).keyReferences, entries);
    const findings = (parsed as { findings?: unknown }).findings;
    if (Array.isArray(findings)) {
        for (const finding of findings) {
            if (typeof finding !== "object" || finding === null) {
                continue;
            }
            pushPmidCitations((finding as { references?: unknown }).references, entries);
        }
    }
    return entries;
}

/** The citation evidence of one analysis: the sorted key list, and the record of each key that carries one. */
interface CollectedCitations {
    readonly keys: string[];
    readonly records: Map<string, CitationRecord>;
}

/**
 * Collect the citation evidence of one analysis from the synthesis record of each of its runs.
 *
 * The pinned set is the literature that the synthesis engaged, and both fields of a record carry it: the
 * key references and the references of each finding. The keys dedupe, and they sort in code-unit order.
 * Thus one disk state gives one list, and a second pin over that state gives the same list.
 *
 * The first record of a key wins. The key references of a record walk before its findings, thus the
 * curated description survives a duplicate that names the same paper with a narrower text.
 *
 * A run listing that fails fails the collection, because a store fault is not absence. Each other fault
 * is a normal condition: an unresolvable workspace root, an absent record, an unreadable record, and a
 * malformed record each give no key and no error.
 */
async function collectCitations(
    pool: Querier,
    resolveWorkspaceRoot: ResolveWorkspaceRoot,
    analysisId: string,
): Promise<Result<CollectedCitations, PinSnapshotError>> {
    let root: string;
    try {
        root = resolveWorkspaceRoot(analysisId);
    } catch {
        // The seam signals an unresolvable resource by a throw. The artifact map still states the
        // membership of the session, thus the fault costs the citation list alone.
        return ok({ keys: [], records: new Map() });
    }

    const keys = new Set<string>();
    const records = new Map<string, CitationRecord>();
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
            for (const entry of citationsOf(text)) {
                keys.add(entry.key);
                if (entry.record !== undefined && !records.has(entry.key)) {
                    records.set(entry.key, entry.record);
                }
            }
        }
        if (page.value.length < RUN_PAGE_SIZE) {
            return ok({ keys: [...keys].sort(), records });
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
    const citations = await collectCitations(pool, options.resolveWorkspaceRoot, analysisId);
    // A collection that recorded nothing stores no map. Thus the snapshot of an analysis whose synthesis
    // carries no citation text reads the same as a pin that predates the map.
    return citations.map(({ keys, records }) =>
        records.size === 0 ? { artifacts, citations: keys } : { artifacts, citations: keys, citationRecords: Object.fromEntries(records) },
    );
}
