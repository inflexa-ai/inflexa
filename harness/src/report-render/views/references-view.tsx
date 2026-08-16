/**
 * The reference markup: the two evidence markers, the ordered provenance list, and the bibliography.
 *
 * The runtime escapes each child and each attribute value, thus a hostile path, a hostile id, or a
 * hostile operation reaches the page as text. Each list keeps the first-appearance order of its ladder,
 * thus the ordinal of each item matches its marker.
 *
 * The two lists render apart, because each one answers a different question and each one wears its own
 * heading. A page with one empty ladder renders that list not at all.
 */

import type { PropsWithChildren } from "hono/jsx";

import { citationRecordOf, type CitationRecords } from "../../report-model/reference-resolver.js";
import type { ArtifactValueReference, CitationReference } from "../../contracts/report-reference.js";
import { citationKeyOf, type ProvenanceReference, type ReferenceLedger, type ReferenceMark } from "../references.js";

/**
 * One provenance marker as a superscript that links to the list entry. The number comes from the ledger as
 * an integer.
 */
export function Marker({ n }: { n: number }) {
    return (
        <sup class="report-marker">
            <a href={`#ref-${n}`}>{n}</a>
        </sup>
    );
}

/**
 * One citation marker as a bracket number that links to the bibliography entry. A reader of a paper reads
 * a bracket as literature, thus the two ladders stay apart on sight.
 */
export function CitationMarker({ n }: { n: number }) {
    return (
        <span class="report-cite-marker">
            <a href={`#cite-${n}`}>{`[${n}]`}</a>
        </span>
    );
}

/** The marker of one mark. The ladder of the mark selects the form, thus a marker and its anchor agree. */
export function LadderMarker({ mark }: { mark: ReferenceMark }) {
    return mark.ladder === "citation" ? <CitationMarker n={mark.n} /> : <Marker n={mark.n} />;
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
 * The inner markup of one provenance entry. An artifact entry names its path, and it adds the locator when
 * the reference pins one cell. A derivation entry names its operation and its two inputs, each by path and
 * locator.
 */
function ReferenceEntry({ reference }: { reference: ProvenanceReference }) {
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
 * The inner markup of one bibliography entry: the short citation of the pinned record, the key, and the
 * description of the record on a line of its own. A key that the record map does not hold shows the key
 * alone, because absence is a normal condition.
 *
 * The description sits in the appendix and never on the card. The card sits in the body of the report,
 * where a paragraph about the paper competes with the prose around it.
 */
function CitationEntry({ reference, records }: { reference: CitationReference; records: CitationRecords | undefined }) {
    const key = citationKeyOf(reference);
    const record = citationRecordOf(records, key);
    const description = record?.description;
    return (
        <>
            {record !== undefined ? (
                <>
                    <span class="report-cite-source">{record.citation}</span>{" "}
                </>
            ) : null}
            <Detail>{key}</Detail>
            {description !== undefined ? <div class="report-cite-description">{description}</div> : null}
        </>
    );
}

/**
 * The provenance list of the appendix: one entry for each artifact reference and each derivation, in the
 * order of the provenance ladder. The list is an appendix: a reader consults one entry from a marker, thus
 * the design keeps it quieter than the body. A ledger with no provenance entry gives an empty string, thus
 * the page shows no empty list.
 */
export function renderReferenceList(ledger: ReferenceLedger): string {
    const entries = ledger.provenanceEntries();
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

/**
 * The bibliography of the appendix: one entry for each cited key, in the order of the citation ladder.
 * Thus the bracket marker of a card names the position of its entry. A ledger with no citation gives an
 * empty string.
 */
export function renderBibliography(ledger: ReferenceLedger, records?: CitationRecords): string {
    const entries = ledger.citationEntries();
    if (entries.length === 0) {
        return "";
    }
    return String(
        <ol class="report-citations">
            {entries.map((reference, index) => (
                <li id={`cite-${index + 1}`} class="report-ref-item">
                    <span class="report-cite-index">{`[${index + 1}]`}</span> <CitationEntry reference={reference} records={records} />
                </li>
            ))}
        </ol>,
    );
}
