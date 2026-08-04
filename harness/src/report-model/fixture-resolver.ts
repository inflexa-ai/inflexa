/**
 * A local, in-memory realization of the reference resolver. It reads only the snapshot that it is given,
 * thus it needs no storage and no network. A test and a benchmark use it to exercise the resolution and
 * assertion rules without a host.
 */

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
import type { ReferenceResolver, ReportSnapshot, ResolveOutcome, ResolvedValue } from "./reference-resolver.js";

/** The authored belief that resolution matches against. Every reference kind can carry one. */
type Assertion = NonNullable<Reference["assert"]>;

/** Build a failure outcome. The `detail` key is present only when there is a detail to carry. */
function fail(reference: Reference, reason: UnresolvedReason, detail?: string): ResolveOutcome {
    const failure: UnresolvedReference = detail !== undefined ? { reference, reason, detail } : { reference, reason };
    return { ok: false, failure };
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

/** A numeric match uses the tolerance as an absolute difference. Any other pair matches on exact equality. */
function valuesMatch(expected: string | number, actual: string | number, tolerance: number | undefined): boolean {
    if (typeof expected === "number" && typeof actual === "number") {
        return Math.abs(expected - actual) <= (tolerance ?? 0);
    }
    return expected === actual;
}

/**
 * Match the resolved value against the authored belief.
 *
 * `artifactHash` is the fresh hash for an artifact kind, and `undefined` for a derivation or a citation.
 * Thus `assert.hash` compares only where an artifact hash exists. `assert.value` has no meaning for a
 * table or a file, because neither has a single value, thus the value check skips the two of them.
 */
function checkAssertion(
    reference: Reference,
    value: ResolvedValue,
    assert: Assertion | undefined,
    artifactHash: string | undefined,
): UnresolvedReference | undefined {
    if (assert === undefined) {
        return undefined;
    }
    if (assert.hash !== undefined && artifactHash !== undefined && assert.hash !== artifactHash) {
        return { reference, reason: "assertion-failed", detail: `expected hash ${assert.hash} but the artifact hash is ${artifactHash}` };
    }
    if (assert.value !== undefined) {
        if (value.type === "scalar" && !valuesMatch(assert.value, value.value, assert.tolerance)) {
            return { reference, reason: "assertion-failed", detail: `expected ${String(assert.value)} but resolved ${String(value.value)}` };
        }
        if (value.type === "citation" && assert.value !== value.id) {
            return { reference, reason: "assertion-failed", detail: `expected ${String(assert.value)} but resolved citation ${value.id}` };
        }
    }
    return undefined;
}

function resolveArtifactValue(reference: ArtifactValueReference, snapshot: ReportSnapshot): ResolveOutcome {
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

    if (!(locator.column in selectedRow)) {
        return fail(reference, "locator-out-of-range", `column ${locator.column} is not in the selected row`);
    }
    const scalar: ResolvedValue = { type: "scalar", value: selectedRow[locator.column] };
    const assertionFailure = checkAssertion(reference, scalar, reference.assert, artifact.hash);
    return assertionFailure !== undefined ? { ok: false, failure: assertionFailure } : { ok: true, value: scalar };
}

function resolveArtifactTable(reference: ArtifactTableReference, snapshot: ReportSnapshot): ResolveOutcome {
    const artifact = snapshot.artifacts[reference.path];
    if (artifact === undefined) {
        return fail(reference, "artifact-missing", `no artifact at ${reference.path}`);
    }
    if (artifact.hash !== reference.hash) {
        return fail(reference, "hash-mismatch", `expected ${reference.hash} but the artifact hash is ${artifact.hash}`);
    }

    const rows = artifact.rows ?? [];
    const columns = reference.columns;
    let value: ResolvedValue;
    if (columns !== undefined) {
        // Project each row onto the requested columns. A table tolerates a ragged row, thus a column that
        // a given row lacks is left out of that row and is not a failure.
        const projectedRows = rows.map((row) => {
            const projected: Record<string, string | number> = {};
            for (const column of columns) {
                if (column in row) {
                    projected[column] = row[column];
                }
            }
            return projected;
        });
        value = { type: "table", rows: projectedRows, columns };
    } else {
        value = { type: "table", rows };
    }

    const assertionFailure = checkAssertion(reference, value, reference.assert, artifact.hash);
    return assertionFailure !== undefined ? { ok: false, failure: assertionFailure } : { ok: true, value };
}

function resolveArtifactFile(reference: ArtifactFileReference, snapshot: ReportSnapshot): ResolveOutcome {
    const artifact = snapshot.artifacts[reference.path];
    if (artifact === undefined) {
        return fail(reference, "artifact-missing", `no artifact at ${reference.path}`);
    }
    if (artifact.hash !== reference.hash) {
        return fail(reference, "hash-mismatch", `expected ${reference.hash} but the artifact hash is ${artifact.hash}`);
    }

    const value: ResolvedValue = { type: "file", path: reference.path, hash: artifact.hash };
    const assertionFailure = checkAssertion(reference, value, reference.assert, artifact.hash);
    return assertionFailure !== undefined ? { ok: false, failure: assertionFailure } : { ok: true, value };
}

async function resolveDerivation(reference: DerivationReference, snapshot: ReportSnapshot): Promise<ResolveOutcome> {
    const numbers: number[] = [];
    for (const input of reference.inputs) {
        const outcome = await resolve(input, snapshot);
        if (!outcome.ok) {
            // Keep the inner reason so a reviewer sees the real cause, for example a missing artifact under
            // the derivation. The derivation itself did not fail on its own terms.
            return fail(reference, outcome.failure.reason, outcome.failure.detail);
        }
        const resolved = outcome.value;
        if (resolved.type !== "scalar" || typeof resolved.value !== "number" || !Number.isFinite(resolved.value)) {
            // The arithmetic needs a finite number. A table, a citation, or a non-numeric cell does not
            // address a usable scalar, thus the closest reason is that the coordinate is out of range.
            return fail(reference, "locator-out-of-range", `input ${describeReference(input)} did not resolve to a finite number`);
        }
        numbers.push(resolved.value);
    }

    if (numbers.length !== 2) {
        return fail(reference, "locator-out-of-range", `operation ${reference.op} needs 2 inputs but got ${numbers.length}`);
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
            result = (a - b) / b;
            break;
    }
    if (!Number.isFinite(result)) {
        return fail(reference, "locator-out-of-range", `operation ${reference.op} does not yield a finite value, because the divisor is zero`);
    }

    const scalar: ResolvedValue = { type: "scalar", value: result };
    const assertionFailure = checkAssertion(reference, scalar, reference.assert, undefined);
    return assertionFailure !== undefined ? { ok: false, failure: assertionFailure } : { ok: true, value: scalar };
}

function resolveCitation(reference: CitationReference, snapshot: ReportSnapshot): ResolveOutcome {
    const key = `${reference.idKind}:${reference.id}`;
    if (snapshot.citations === undefined || !snapshot.citations.includes(key)) {
        return fail(reference, "artifact-missing", `the citation ${key} is not in the pinned evidence`);
    }
    const value: ResolvedValue = { type: "citation", id: key };
    const assertionFailure = checkAssertion(reference, value, reference.assert, undefined);
    return assertionFailure !== undefined ? { ok: false, failure: assertionFailure } : { ok: true, value };
}

async function resolve(reference: Reference, snapshot: ReportSnapshot): Promise<ResolveOutcome> {
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
