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
    DerivationReference,
    NonDerivationReference,
    Reference,
    UnresolvedReason,
    UnresolvedReference,
} from "../contracts/report-reference.js";
import { columnsHeldByNoRow, type ReferenceResolver, type ReportSnapshot, type ResolvedValue } from "./reference-resolver.js";

/**
 * The relative epsilon of a value match with no authored tolerance.
 *
 * An author writes a rounded figure, but the resolver computes the value again in floating point. Thus
 * exact equality would report ordinary float noise as a fabrication. This epsilon absorbs the noise, and
 * it is still far too small to hide a real mismatch such as 1.5 against 1.05.
 */
const RELATIVE_EPSILON = 1e-9;

/** Build an `Err` that carries the unresolved reference. The `detail` key is present only when there is a detail to carry. */
function fail(reference: Reference, reason: UnresolvedReason, detail?: string): Result<ResolvedValue, UnresolvedReference> {
    const failure: UnresolvedReference = detail !== undefined ? { reference, reason, detail } : { reference, reason };
    return err(failure);
}

/** A short account of a derivation input, for a detail that names which input broke the arithmetic. */
function describeReference(reference: NonDerivationReference): string {
    switch (reference.kind) {
        case "artifact-value":
            return `artifact value at ${reference.path} column ${reference.locator.column}`;
        case "artifact-table":
            return `artifact table at ${reference.path}`;
        case "artifact-file":
            return `artifact file at ${reference.path}`;
        case "citation":
            return `citation ${reference.idKind}:${reference.id}`;
    }
}

/**
 * Match a resolved value against an authored one.
 *
 * An authored tolerance is an absolute difference, and it is the author's own statement of how close is
 * close enough. With no tolerance the comparison is relative, because an exact match would fail on the
 * float noise of a computed value. Any pair that is not two numbers matches on exact equality.
 */
function valuesMatch(expected: string | number, actual: string | number, tolerance: number | undefined): boolean {
    if (typeof expected === "number" && typeof actual === "number") {
        if (tolerance !== undefined) {
            return Math.abs(expected - actual) <= tolerance;
        }
        return Math.abs(expected - actual) <= RELATIVE_EPSILON * Math.max(1, Math.abs(expected), Math.abs(actual));
    }
    return expected === actual;
}

/** Match a resolved scalar against the authored value, under the authored tolerance. */
function checkValueAssertion(
    reference: Reference,
    expected: string | number | undefined,
    tolerance: number | undefined,
    resolved: string | number,
): UnresolvedReference | undefined {
    if (expected === undefined || valuesMatch(expected, resolved, tolerance)) {
        return undefined;
    }
    return { reference, reason: "assertion-failed", detail: `expected ${String(expected)} but resolved ${String(resolved)}` };
}

/** Match the resolved citation key against the authored value. The key carries its `idKind:` prefix. */
function checkCitationAssertion(reference: Reference, expected: string | number | undefined, resolved: string): UnresolvedReference | undefined {
    if (expected === undefined || expected === resolved) {
        return undefined;
    }
    return { reference, reason: "assertion-failed", detail: `expected ${String(expected)} but resolved citation ${resolved}` };
}

function resolveArtifactValue(reference: ArtifactValueReference, snapshot: ReportSnapshot): Result<ResolvedValue, UnresolvedReference> {
    const artifact = snapshot.artifacts[reference.path];
    if (artifact === undefined) {
        return fail(reference, "artifact-missing", `no artifact at ${reference.path}`);
    }
    if (artifact.hash !== reference.hash) {
        return fail(reference, "hash-mismatch", `expected ${reference.hash} but the artifact hash is ${artifact.hash}`);
    }

    // An artifact with no rows is pinned whole, thus it addresses no cell and every locator over it lands
    // out of range.
    const rows = artifact.rows ?? [];
    const locator = reference.locator;
    let selectedRow: Record<string, string | number>;
    if (locator.row !== undefined) {
        if (locator.row < 0 || locator.row >= rows.length) {
            return fail(reference, "locator-out-of-range", `row ${locator.row} is outside the ${rows.length} rows`);
        }
        selectedRow = rows[locator.row];
    } else if (locator.rowFilter !== undefined) {
        const filter = locator.rowFilter;
        const matches = rows.filter((row) => row[filter.column] === filter.value);
        if (matches.length === 0) {
            return fail(reference, "locator-out-of-range", `no row where ${filter.column} equals ${String(filter.value)}`);
        }
        if (matches.length > 1) {
            return fail(reference, "ambiguous-match", `${matches.length} rows where ${filter.column} equals ${String(filter.value)}`);
        }
        selectedRow = matches[0];
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

function resolveArtifactTable(reference: ArtifactTableReference, snapshot: ReportSnapshot): Result<ResolvedValue, UnresolvedReference> {
    const artifact = snapshot.artifacts[reference.path];
    if (artifact === undefined) {
        return fail(reference, "artifact-missing", `no artifact at ${reference.path}`);
    }
    if (artifact.hash !== reference.hash) {
        return fail(reference, "hash-mismatch", `expected ${reference.hash} but the artifact hash is ${artifact.hash}`);
    }

    const rows = artifact.rows ?? [];
    const columns = reference.columns;
    if (columns === undefined) {
        return ok({ type: "table", rows });
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
            if (column in row) {
                projected[column] = row[column];
            }
        }
        return projected;
    });
    return ok({ type: "table", rows: projectedRows, columns });
}

function resolveArtifactFile(reference: ArtifactFileReference, snapshot: ReportSnapshot): Result<ResolvedValue, UnresolvedReference> {
    const artifact = snapshot.artifacts[reference.path];
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
        if (resolved.type !== "scalar" || typeof resolved.value !== "number" || !Number.isFinite(resolved.value)) {
            // The arithmetic needs a finite number. A table, a citation, or a non-numeric cell does not
            // address a usable scalar, thus the closest reason is that the coordinate is out of range.
            return fail(reference, "locator-out-of-range", `input ${describeReference(input)} did not resolve to a finite number`);
        }
        numbers.push(resolved.value);
    }

    const a = numbers[0];
    const b = numbers[1];
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
