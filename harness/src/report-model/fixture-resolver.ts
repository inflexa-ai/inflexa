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
    CitationReference,
    DerivationInputReference,
    DerivationReference,
    Reference,
    UnresolvedReason,
    UnresolvedReference,
} from "../contracts/report-reference.js";
import { asFiniteNumber, cellMatchesFilterValue, checkCitationAssertion, checkValueAssertion } from "./assert-rules.js";
import {
    applyRowBound,
    columnsHeldByNoRow,
    fileTypeHoldsNoCell,
    snapshotEntry,
    snapshotRows,
    type ReferenceResolver,
    type ReportSnapshot,
    type ResolvedValue,
} from "./reference-resolver.js";

/** Build an `Err` that carries the unresolved reference. The `detail` key is present only when there is a detail to carry. */
function fail(reference: Reference, reason: UnresolvedReason, detail?: string): Result<ResolvedValue, UnresolvedReference> {
    const failure: UnresolvedReference = detail !== undefined ? { reference, reason, detail } : { reference, reason };
    return err(failure);
}

/** A short account of a derivation input, for a detail that names which input broke the arithmetic. */
function describeReference(reference: DerivationInputReference): string {
    return `artifact value at ${reference.path} column ${reference.locator.column}`;
}

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
        return fail(reference, "unreadable-artifact", `the ${valueFileType} at ${reference.path} holds no cell to read`);
    }

    // An artifact with no rows is pinned whole, thus it addresses no cell and every locator over it lands
    // out of range.
    const readRows = snapshotRows(artifact);
    if (readRows.isErr()) {
        return fail(reference, "unreadable-artifact", `the artifact at ${reference.path} holds a malformed row: ${readRows.error}`);
    }
    const rows = readRows.value;
    const locator = reference.locator;
    let selectedRow: Record<string, string | number>;
    if (locator.row !== undefined) {
        const row = rows[locator.row];
        if (row === undefined) {
            return fail(reference, "locator-out-of-range", `row ${locator.row} is outside the ${rows.length} rows`);
        }
        selectedRow = row;
    } else if (locator.rowFilter !== undefined) {
        const filter = locator.rowFilter;
        const matches = rows.filter((row) => cellMatchesFilterValue(row[filter.column], filter.value));
        const match = matches[0];
        if (match === undefined) {
            return fail(reference, "locator-out-of-range", `no row where ${filter.column} equals ${String(filter.value)}`);
        }
        if (matches.length > 1) {
            return fail(reference, "ambiguous-match", `${matches.length} rows where ${filter.column} equals ${String(filter.value)}`);
        }
        selectedRow = match;
    } else {
        // The locator schema forbids a locator with neither selector. The resolver cannot depend on a
        // prior parse, thus it treats a row that no selector addresses as out of range.
        return fail(reference, "locator-out-of-range", "the locator selects no row");
    }

    // A real table holds an empty cell, and a parser gives it back as an absent key, `undefined`, or
    // `null`. None of the three is a value that a scalar reference can bind. An empty string is a value,
    // thus it stays valid. The wider annotation admits the three, because the row type promises a value
    // for each key that it holds.
    const cell: string | number | null | undefined = selectedRow[locator.column];
    if (cell === undefined || cell === null) {
        return fail(reference, "locator-out-of-range", `column ${locator.column} holds no value in the selected row`);
    }

    const valueFailure = checkValueAssertion(reference, reference.assert?.value, reference.assert?.tolerance, cell);
    return valueFailure !== undefined ? err(valueFailure) : ok({ type: "scalar", value: cell });
}

/**
 * Put one own data property on a projected row.
 *
 * A plain assignment at the key `__proto__` reaches the prototype setter, thus the projection loses a
 * column that the row holds. The definition makes an own data property for each key.
 */
function defineOwn(target: Record<string, string | number>, key: string, value: string | number): void {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
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
        return fail(reference, "unreadable-artifact", `the ${tableFileType} at ${reference.path} holds no cell to read`);
    }

    // The bound ranks the rows as the artifact holds them, thus a bound over a column that the subset
    // below leaves out still ranks them. An unknown bound column addresses nothing, exactly as an unknown
    // subset column does.
    const bound = reference.rowBound;
    const readRows = snapshotRows(artifact);
    if (readRows.isErr()) {
        return fail(reference, "unreadable-artifact", `the artifact at ${reference.path} holds a malformed row: ${readRows.error}`);
    }
    const allRows = readRows.value;
    if (bound !== undefined && columnsHeldByNoRow(allRows, [bound.column]).length > 0) {
        return fail(reference, "locator-out-of-range", `the row bound names column ${bound.column}, which the table at ${reference.path} does not hold`);
    }
    const rows = bound === undefined ? allRows : applyRowBound(allRows, bound);
    // The page states the shown count against the count of the artifact. This read is the one place that
    // holds both, thus a bounded table carries the pre-bound total out with its rows.
    const total = bound === undefined ? {} : { total: allRows.length };
    const columns = reference.columns;
    if (columns === undefined) {
        return ok({ type: "table", rows, ...total });
    }

    // A name that no row holds addresses nothing. Without this check a projection onto an invented column
    // gives an empty cell for each row and still resolves, which is the fabrication that grounding exists
    // to reject.
    const absent = columnsHeldByNoRow(rows, columns);
    if (absent.length > 0) {
        return fail(reference, "locator-out-of-range", `the table at ${reference.path} holds no column ${absent.join(", ")}`);
    }

    // Project each row onto the requested columns. A table tolerates a ragged row, thus a column that a
    // given row lacks is left out of that row and is not a failure.
    const projectedRows = rows.map((row) => {
        const projected: Record<string, string | number> = {};
        for (const column of columns) {
            const cell = row[column];
            if (cell !== undefined) {
                defineOwn(projected, column, cell);
            }
        }
        return projected;
    });
    return ok({ type: "table", rows: projectedRows, columns, ...total });
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

async function resolveDerivation(reference: DerivationReference, snapshot: ReportSnapshot): Promise<Result<ResolvedValue, UnresolvedReference>> {
    const numbers: number[] = [];
    for (const input of reference.inputs) {
        const inputResult = await resolve(input, snapshot);
        if (inputResult.isErr()) {
            // Keep the inner reason so a reviewer sees the real cause, for example a missing artifact under
            // the derivation. The derivation itself did not fail on its own terms.
            return fail(reference, inputResult.error.reason, inputResult.error.detail);
        }
        const resolved = inputResult.value;
        const numeric = resolved.type === "scalar" ? asFiniteNumber(resolved.value) : undefined;
        if (numeric === undefined) {
            // The arithmetic needs a finite number. A cell that holds text does not address a usable
            // scalar, thus the closest reason is that the coordinate is out of range.
            return fail(reference, "locator-out-of-range", `input ${describeReference(input)} did not resolve to a finite number`);
        }
        numbers.push(numeric);
    }

    const a = numbers[0];
    const b = numbers[1];
    if (a === undefined || b === undefined) {
        return fail(reference, "locator-out-of-range", `operation ${reference.op} needs two inputs, and the derivation holds ${numbers.length}`);
    }
    let result: number;
    switch (reference.op) {
        case "ratio":
            result = a / b;
            break;
        case "delta":
            result = a - b;
            break;
        case "pctChange":
            // A fraction, not a percent. A change of one half gives 0.5, thus an author asserts 0.5 and a
            // `unit` of `%` only tells a renderer how to show it.
            result = (a - b) / b;
            break;
    }
    if (!Number.isFinite(result)) {
        return fail(reference, "locator-out-of-range", `operation ${reference.op} does not yield a finite value, because the divisor is zero`);
    }

    const valueFailure = checkValueAssertion(reference, reference.assert?.value, reference.assert?.tolerance, result);
    return valueFailure !== undefined ? err(valueFailure) : ok({ type: "scalar", value: result });
}

function resolveCitation(reference: CitationReference, snapshot: ReportSnapshot): Result<ResolvedValue, UnresolvedReference> {
    const key = `${reference.idKind}:${reference.id}`;
    if (snapshot.citations === undefined || !snapshot.citations.includes(key)) {
        return fail(reference, "artifact-missing", `the citation ${key} is not in the pinned evidence`);
    }
    const value: ResolvedValue = { type: "citation", id: key };
    const citationFailure = checkCitationAssertion(reference, reference.assert?.value, key);
    return citationFailure !== undefined ? err(citationFailure) : ok(value);
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
            return resolveDerivation(reference, snapshot);
        case "citation":
            return resolveCitation(reference, snapshot);
    }
}

/** Make a resolver that reads only the snapshot. It holds no state, thus one instance serves every call. */
export function createFixtureResolver(): ReferenceResolver {
    return { resolve };
}
