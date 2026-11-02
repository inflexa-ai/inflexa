/**
 * The reads of a report reference that the two resolver realizations share.
 *
 * The fixture resolver reads the rows of a snapshot, and the production resolver reads the rows of the
 * pinned artifact on disk. What both do with those rows — the locator walk, the table read, and the
 * derivation arithmetic — lives here, so one semantics exists for both realizations.
 */

import { err, ok, type Result } from "neverthrow";

import type {
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
import { applyRowBound, columnsHeldByNoRow, defineOwn, type ReportSnapshot, type ResolvedValue } from "./reference-resolver.js";

/** Build an `Err` that carries the unresolved reference. The `detail` key is present only when there is a detail to carry. */
export function fail(reference: Reference, reason: UnresolvedReason, detail?: string): Result<ResolvedValue, UnresolvedReference> {
    const failure: UnresolvedReference = detail !== undefined ? { reference, reason, detail } : { reference, reason };
    return err(failure);
}

/** A short account of a derivation input, for a detail that names which input broke the arithmetic. */
function describeReference(reference: DerivationInputReference): string {
    return `artifact value at ${reference.path} column ${reference.locator.column}`;
}

/** The failure of a row selection: the reason that an `UnresolvedReference` carries, and its detail. */
export type RowSelectionFailure = {
    reason: "locator-out-of-range" | "ambiguous-match";
    detail: string;
};

/**
 * Walk a locator over the rows, and give back the one row that it selects, or the failure.
 *
 * A row index selects the row at that position. A row filter selects the one row that matches; no match
 * selects nothing, and two or more matches are ambiguous.
 */
export function selectRow(
    rows: Array<Record<string, string | number>>,
    locator: ArtifactValueReference["locator"],
): Result<Record<string, string | number>, RowSelectionFailure> {
    if (locator.row !== undefined) {
        const row = rows[locator.row];
        if (row === undefined) {
            return err({ reason: "locator-out-of-range", detail: `row ${locator.row} is outside the ${rows.length} rows` });
        }
        return ok(row);
    }
    if (locator.rowFilter !== undefined) {
        const filter = locator.rowFilter;
        const matches = rows.filter((row) => cellMatchesFilterValue(row[filter.column], filter.value));
        const match = matches[0];
        if (match === undefined) {
            return err({ reason: "locator-out-of-range", detail: `no row where ${filter.column} equals ${String(filter.value)}` });
        }
        if (matches.length > 1) {
            return err({ reason: "ambiguous-match", detail: `${matches.length} rows where ${filter.column} equals ${String(filter.value)}` });
        }
        return ok(match);
    }
    // The locator schema forbids a locator with neither selector. The resolver cannot depend on a
    // prior parse, thus it treats a row that no selector addresses as out of range.
    return err({ reason: "locator-out-of-range", detail: "the locator selects no row" });
}

/**
 * Read the table that a table reference addresses out of rows that the caller read from the artifact:
 * cut the rows on the row bound, refuse a column that no row holds, and project the requested columns.
 */
export function readArtifactTable(
    reference: ArtifactTableReference,
    allRows: Array<Record<string, string | number>>,
): Result<ResolvedValue, UnresolvedReference> {
    // The bound ranks the rows as the artifact holds them, thus a bound over a column that the subset
    // below leaves out still ranks them. An unknown bound column addresses nothing, exactly as an
    // unknown subset column does.
    const bound = reference.rowBound;
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

/**
 * Resolve a derivation: read each input with `resolveInput`, then run the arithmetic of the operation.
 *
 * The read of an input stays with the realization: the fixture resolver reads its snapshot, and the
 * production resolver reads the pinned artifact on disk.
 */
export async function resolveDerivation(
    reference: DerivationReference,
    snapshot: ReportSnapshot,
    resolveInput: (input: DerivationInputReference, snapshot: ReportSnapshot) => Promise<Result<ResolvedValue, UnresolvedReference>>,
): Promise<Result<ResolvedValue, UnresolvedReference>> {
    const numbers: number[] = [];
    for (const input of reference.inputs) {
        const inputResult = await resolveInput(input, snapshot);
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

/** Resolve a citation: confirm that the id is in the pinned evidence, and echo the key back. */
export function resolveCitation(reference: CitationReference, snapshot: ReportSnapshot): Result<ResolvedValue, UnresolvedReference> {
    const key = `${reference.idKind}:${reference.id}`;
    if (snapshot.citations === undefined || !snapshot.citations.includes(key)) {
        return fail(reference, "artifact-missing", `the citation ${key} is not in the pinned evidence`);
    }
    const value: ResolvedValue = { type: "citation", id: key };
    const citationFailure = checkCitationAssertion(reference, reference.assert?.value, key);
    return citationFailure !== undefined ? err(citationFailure) : ok(value);
}
