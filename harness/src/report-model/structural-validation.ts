/**
 * The structural tier of reference resolution.
 *
 * The tier answers from the pinned snapshot alone, and it opens no file. Thus an authoring operation can
 * run it on each change, and it stays instant while a document grows.
 *
 * The value tier gives the value that a reference points at, and only a read of the artifact gives that
 * value. As a result the costly read happens one time for each report version, and never for each edit.
 */

import { err, ok, type Result } from "neverthrow";

import type {
    ArtifactFileReference,
    ArtifactTableReference,
    ArtifactValueReference,
    Reference,
    UnresolvedReason,
    UnresolvedReference,
} from "../contracts/report-reference.js";
import { columnsHeldByNoRow, fileTypeHoldsNoCell, snapshotEntry, type ReportSnapshot } from "./reference-resolver.js";

/** The three reference kinds that name one artifact directly. Each one carries the artifact pin fields. */
type PinnedReference = ArtifactValueReference | ArtifactTableReference | ArtifactFileReference;

/** Build an `Err` that carries the unresolved reference. The `detail` key is present only when there is a detail to carry. */
function fail(reference: Reference, reason: UnresolvedReason, detail?: string): Result<void, UnresolvedReference> {
    const failure: UnresolvedReference = detail !== undefined ? { reference, reason, detail } : { reference, reason };
    return err(failure);
}

/** Validate the artifact pin of one reference: its membership in the snapshot, its identity, and the file type of its entry. */
function validatePin(reference: PinnedReference, snapshot: ReportSnapshot): Result<void, UnresolvedReference> {
    const entry = snapshotEntry(snapshot, reference.path);
    if (entry === undefined) {
        return fail(reference, "artifact-missing", `no artifact at ${reference.path}`);
    }
    if (entry.hash !== reference.hash) {
        return fail(reference, "hash-mismatch", `expected ${reference.hash} but the artifact hash is ${entry.hash}`);
    }

    // An `artifact-file` pins the bytes of a whole file, thus each file type is valid for it. A figure
    // block binds through `artifact-file`, and a rule that refused a `figure` here would fail each figure
    // of each report.
    const readsACell = reference.kind === "artifact-value" || reference.kind === "artifact-table";
    const fileType = entry.fileType;
    if (readsACell && fileTypeHoldsNoCell(fileType)) {
        return fail(reference, "unreadable-artifact", `the ${fileType} at ${reference.path} holds no cell to read`);
    }
    return ok();
}

/**
 * Match each column that a chart grammar names against the table that the block binds.
 *
 * The tier reads the snapshot alone, thus it answers from the two things that the snapshot holds. A table
 * reference that declares a column subset answers on its own terms, because a name outside the subset
 * addresses nothing. A snapshot entry that carries rows answers from those rows.
 *
 * A snapshot that pins identity alone holds no rows. Such a snapshot contradicts no name, thus the tier
 * passes and the value tier settles the match over the artifact that it reads.
 */
function validateColumns(reference: ArtifactTableReference, snapshot: ReportSnapshot, columns: readonly string[]): Result<void, UnresolvedReference> {
    const subset = reference.columns;
    if (subset !== undefined) {
        const outside = columns.filter((column) => !subset.includes(column));
        if (outside.length > 0) {
            return fail(reference, "locator-out-of-range", `the chart names column ${outside.join(", ")}, which the bound column subset leaves out`);
        }
    }
    const absent = columnsHeldByNoRow(snapshotEntry(snapshot, reference.path)?.rows ?? [], columns);
    if (absent.length > 0) {
        return fail(reference, "locator-out-of-range", `the chart names column ${absent.join(", ")}, which the bound table does not hold`);
    }
    return ok();
}

/**
 * Validate one reference against the snapshot.
 *
 * The `Ok` channel carries no value. The tier answers membership, identity, and the file type, and a
 * value comes from a read of the artifact. An `assert` is the authored belief about that value, thus this
 * tier matches no assertion and a reference that carries one passes on its pin alone.
 *
 * `columns` carries each column that the grammar of a chart block names. The walk collects them, thus a
 * chart that plots an invented column refuses before it lands, wherever the snapshot can answer.
 *
 * The answer is synchronous, because the snapshot is already in memory.
 */
export function validateReferenceStructure(reference: Reference, snapshot: ReportSnapshot, columns?: readonly string[]): Result<void, UnresolvedReference> {
    switch (reference.kind) {
        case "artifact-table": {
            const pin = validatePin(reference, snapshot);
            if (pin.isErr() || columns === undefined || columns.length === 0) {
                return pin;
            }
            return validateColumns(reference, snapshot, columns);
        }
        case "artifact-value":
        case "artifact-file":
            return validatePin(reference, snapshot);
        case "derivation": {
            // A derivation holds no pin of its own, thus it is grounded exactly when both of its inputs
            // are grounded. The failure keeps the reason of the input, because the derivation itself did
            // not fail on its own terms.
            for (const input of reference.inputs) {
                const inputResult = validatePin(input, snapshot);
                if (inputResult.isErr()) {
                    return fail(reference, inputResult.error.reason, inputResult.error.detail);
                }
            }
            return ok();
        }
        case "citation":
            // A citation holds an external id and no path, thus the snapshot has nothing to say about it.
            // The citation authorities settle its truth at the value tier.
            return ok();
    }
}
