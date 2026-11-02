/**
 * A local, in-memory realization of the reference resolver. It reads only the snapshot that it is given,
 * thus it needs no storage and no network. A test and a benchmark use it to exercise the resolution and
 * assertion rules without a host.
 */

import { err, ok, type Result } from "neverthrow";

import type {
    ArtifactFileReference,
    ArtifactTableReference,
    ArtifactValueReference,
    Reference,
    UnresolvedReference,
} from "../contracts/report-reference.js";
import { checkValueAssertion } from "./assert-rules.js";
import { fail, readArtifactTable, resolveCitation, resolveDerivation, selectRow } from "./reference-read.js";
import {
    fileTypeHoldsNoCell,
    snapshotEntry,
    snapshotRows,
    type ReferenceResolver,
    type ReportSnapshot,
    type ResolvedValue,
} from "./reference-resolver.js";

function resolveArtifactValue(reference: ArtifactValueReference, snapshot: ReportSnapshot): Result<ResolvedValue, UnresolvedReference> {
    const artifact = snapshotEntry(snapshot, reference.path);
    if (artifact === undefined) {
        return fail(reference, "artifact-missing", `no artifact at ${reference.path}`);
    }
    if (artifact.hash !== reference.hash) {
        return fail(reference, "hash-mismatch", `expected ${reference.hash} but the artifact hash is ${artifact.hash}`);
    }

    // A caller supplies the rows of a fixture. A fixture that supplies rows for a figure would resolve a
    // cell that no real artifact holds. Thus the refusal comes before the read of the rows.
    const valueFileType = artifact.fileType;
    if (fileTypeHoldsNoCell(valueFileType)) {
        return fail(reference, "unreadable-artifact", `the ${String(valueFileType)} at ${reference.path} holds no cell to read`);
    }

    // An artifact with no rows is pinned whole, thus it addresses no cell and every locator over it lands
    // out of range.
    const readRows = snapshotRows(artifact);
    if (readRows.isErr()) {
        return fail(reference, "unreadable-artifact", `the artifact at ${reference.path} holds a malformed row: ${readRows.error}`);
    }
    const locator = reference.locator;
    const selection = selectRow(readRows.value, locator);
    if (selection.isErr()) {
        return fail(reference, selection.error.reason, selection.error.detail);
    }

    // A real table holds an empty cell, and the snapshot parser gives it back as an absent
    // key: `snapshotRows` drops a cell that parsed as `null` or `undefined`, so an absent key
    // is the only absence. It is not a value that a scalar reference can bind. An empty
    // string is a value, thus it stays valid.
    const cell = selection.value[locator.column];
    if (cell === undefined) {
        return fail(reference, "locator-out-of-range", `column ${locator.column} holds no value in the selected row`);
    }

    const valueFailure = checkValueAssertion(reference, reference.assert?.value, reference.assert?.tolerance, cell);
    return valueFailure !== undefined ? err(valueFailure) : ok({ type: "scalar", value: cell });
}

function resolveArtifactTable(reference: ArtifactTableReference, snapshot: ReportSnapshot): Result<ResolvedValue, UnresolvedReference> {
    const artifact = snapshotEntry(snapshot, reference.path);
    if (artifact === undefined) {
        return fail(reference, "artifact-missing", `no artifact at ${reference.path}`);
    }
    if (artifact.hash !== reference.hash) {
        return fail(reference, "hash-mismatch", `expected ${reference.hash} but the artifact hash is ${artifact.hash}`);
    }

    const tableFileType = artifact.fileType;
    if (fileTypeHoldsNoCell(tableFileType)) {
        return fail(reference, "unreadable-artifact", `the ${String(tableFileType)} at ${reference.path} holds no cell to read`);
    }

    const readRows = snapshotRows(artifact);
    if (readRows.isErr()) {
        return fail(reference, "unreadable-artifact", `the artifact at ${reference.path} holds a malformed row: ${readRows.error}`);
    }
    return readArtifactTable(reference, readRows.value);
}

function resolveArtifactFile(reference: ArtifactFileReference, snapshot: ReportSnapshot): Result<ResolvedValue, UnresolvedReference> {
    const artifact = snapshotEntry(snapshot, reference.path);
    if (artifact === undefined) {
        return fail(reference, "artifact-missing", `no artifact at ${reference.path}`);
    }
    if (artifact.hash !== reference.hash) {
        return fail(reference, "hash-mismatch", `expected ${reference.hash} but the artifact hash is ${artifact.hash}`);
    }

    return ok({ type: "file", path: reference.path, hash: artifact.hash });
}

async function resolve(reference: Reference, snapshot: ReportSnapshot): Promise<Result<ResolvedValue, UnresolvedReference>> {
    switch (reference.kind) {
        case "artifact-value":
            return resolveArtifactValue(reference, snapshot);
        case "artifact-table":
            return resolveArtifactTable(reference, snapshot);
        case "artifact-file":
            return resolveArtifactFile(reference, snapshot);
        case "derivation":
            return resolveDerivation(reference, snapshot, resolve);
        case "citation":
            return resolveCitation(reference, snapshot);
    }
}

/** Make a resolver that reads only the snapshot. It holds no state, thus one instance serves every call. */
export function createFixtureResolver(): ReferenceResolver {
    return { resolve };
}
