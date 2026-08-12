/**
 * The reference markup: the evidence marker and the ordered reference list.
 *
 * The runtime escapes each child and each attribute value, thus a hostile path, a hostile id, or a
 * hostile operation reaches the page as text. The list keeps the first-appearance order of the ledger,
 * thus the ordinal of each item matches its marker.
 */

import type { PropsWithChildren } from "hono/jsx";

import type { ArtifactValueReference, Reference } from "../../contracts/report-reference.js";
import type { ReferenceLedger } from "../references.js";

/**
 * One evidence marker as a superscript that links to the list entry. The number comes from the ledger as
 * an integer.
 */
export function Marker({ n }: { n: number }) {
    return (
        <sup class="report-marker">
            <a href={`#ref-${n}`}>{n}</a>
        </sup>
    );
}

/** The kind label of one reference entry. */
function RefKind({ children }: PropsWithChildren) {
    return <span class="report-ref-kind">{children}</span>;
}

/** A path in a monospace code span. */
function PathCode({ children }: PropsWithChildren) {
    return <code class="report-ref-path">{children}</code>;
}

/** A plain detail such as a locator or an external id. */
function Detail({ children }: PropsWithChildren) {
    return <span class="report-ref-detail">{children}</span>;
}

/**
 * Describe a locator as plain text: the column and the one row selector. The refine of the schema admits
 * exactly one of `row` or `rowFilter`, thus the two branches cover a valid locator.
 */
function describeLocator(locator: ArtifactValueReference["locator"]): string {
    if (locator.row !== undefined) {
        return `column ${locator.column}, row ${locator.row}`;
    }
    const filter = locator.rowFilter;
    if (filter !== undefined) {
        return `column ${locator.column}, row where ${filter.column} ${filter.op} ${String(filter.value)}`;
    }
    return `column ${locator.column}`;
}

/**
 * The inner markup of one list entry. An artifact entry names its path, and it adds the locator when the
 * reference pins one cell. A citation entry names its identifier space and its id. A derivation entry
 * names its operation and its two inputs, each by path and locator.
 */
function ReferenceEntry({ reference }: { reference: Reference }) {
    switch (reference.kind) {
        case "artifact-value":
            return (
                <>
                    <RefKind>Artifact value</RefKind> <PathCode>{reference.path}</PathCode> <Detail>{describeLocator(reference.locator)}</Detail>
                </>
            );
        case "artifact-table":
            return (
                <>
                    <RefKind>Artifact table</RefKind> <PathCode>{reference.path}</PathCode>
                </>
            );
        case "artifact-file":
            return (
                <>
                    <RefKind>Artifact file</RefKind> <PathCode>{reference.path}</PathCode>
                </>
            );
        case "citation":
            return (
                <>
                    <RefKind>Citation</RefKind> <Detail>{`${reference.idKind}:${reference.id}`}</Detail>
                </>
            );
        case "derivation":
            return (
                <>
                    <RefKind>{`Derivation (${reference.op})`}</RefKind>{" "}
                    {reference.inputs.map((input, index) => (
                        <>
                            {index > 0 ? " and " : ""}
                            <PathCode>{input.path}</PathCode> <Detail>{describeLocator(input.locator)}</Detail>
                        </>
                    ))}
                </>
            );
    }
}

/**
 * The ordered reference list for the end of the page. An empty ledger gives an empty string, thus the
 * page shows no empty list.
 */
export function renderReferenceList(ledger: ReferenceLedger): string {
    const entries = ledger.entries();
    if (entries.length === 0) {
        return "";
    }
    return String(
        <ol class="report-references">
            {entries.map((reference, index) => (
                <li id={`ref-${index + 1}`} class="report-ref-item">
                    <ReferenceEntry reference={reference} />
                </li>
            ))}
        </ol>,
    );
}
