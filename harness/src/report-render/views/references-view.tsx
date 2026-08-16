/**
 * The reference markup: the one evidence marker, and the one appendix list under it.
 *
 * The runtime escapes each child and each attribute value, thus a hostile path, a hostile id, or a
 * hostile operation reaches the page as text. The list keeps the first-appearance order of the ladder,
 * thus the ordinal of each item matches its marker.
 *
 * One list holds both reference kinds, flat and in number order. Each entry leads with a kind tag, thus an
 * artifact entry and a literature entry stay apart on sight without a heading between them. A page with an
 * empty ledger renders no list at all.
 */

import type { PropsWithChildren } from "hono/jsx";

import { citationRecordOf, type CitationRecords } from "../../report-model/reference-resolver.js";
import type { ArtifactValueReference, CitationReference, Reference } from "../../contracts/report-reference.js";
import { citationKeyOf, type ArtifactReference, type DerivationChain, type DerivationChains, type ReferenceLedger } from "../references.js";

/**
 * One evidence marker as a bracket number that links to its appendix entry.
 *
 * A bracket reads as a reference inside prose, and it stays a span beside the words. One notation serves
 * every kind, thus one list answers every marker.
 */
export function Marker({ n }: { n: number }) {
    return (
        <span class="report-marker">
            <a href={`#ref-${n}`}>{`[${n}]`}</a>
        </span>
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

/** The head of a content hash in a monospace span. */
function HashCode({ children }: PropsWithChildren) {
    return <code class="report-ref-hash">{children}</code>;
}

/**
 * The count of hash characters that a chain line shows.
 *
 * A content hash is 64 hex characters, and a line that carries three whole ones reads as noise. The head
 * identifies the bytes, and it matches the count that a staged file name carries. Thus a reader compares the
 * two by sight.
 */
const CHAIN_HASH_CHARS = 12;

/** The head of one content hash: the hex after the algorithm name, cut to the shown length. */
function hashHead(hash: string): string {
    return hash.slice(hash.lastIndexOf(":") + 1).slice(0, CHAIN_HASH_CHARS);
}

/**
 * The head of the script hash, as a link to the staged script where the caller staged one.
 *
 * The hash head stays the text of the link. Thus the reader reads the same head as before, and the click
 * opens the script itself. A chain with no staged script shows the head alone.
 */
function ScriptLink({ chain }: { chain: DerivationChain }) {
    const head = <HashCode>{hashHead(chain.scriptHash)}</HashCode>;
    return chain.scriptSource === undefined ? (
        head
    ) : (
        <a class="report-ref-link" href={chain.scriptSource}>
            {head}
        </a>
    );
}

/**
 * The chain of one derived path: each source with the head of its hash, then the head of the script hash,
 * then the derived file.
 *
 * The line rides under the entry of the path, thus the entry itself keeps the form of a pinned artifact and
 * the chain adds one quiet line under it. A reader mounts the same sources, runs the same script, and gets
 * the same bytes.
 *
 * The script and the derived file are relative links, thus the whole chain walks with no network and no
 * host. Each hash head stays beside its link, because the head is what a reader compares against the name of
 * a staged file.
 */
function ChainLine({ chain }: { chain: DerivationChain }) {
    return (
        <div class="report-ref-chain">
            <RefKind>Derived from</RefKind>{" "}
            {chain.sources.map((source, index) => (
                <>
                    {index > 0 ? " and " : ""}
                    <PathCode>{source.path}</PathCode> <HashCode>{hashHead(source.hash)}</HashCode>
                </>
            ))}{" "}
            <Detail>by script</Detail> <ScriptLink chain={chain} />
            {chain.outputSource !== undefined ? (
                <>
                    {" "}
                    <Detail>into</Detail>{" "}
                    <a class="report-ref-link" href={chain.outputSource}>
                        <PathCode>{chain.outputSource}</PathCode>
                    </a>
                </>
            ) : null}
        </div>
    );
}

/**
 * The one path that an artifact reference names, or `undefined` for a kind that names no single file.
 *
 * A derivation reference computes over two inputs, thus it names no output file of its own and no chain
 * belongs to it.
 */
function pathOf(reference: ArtifactReference): string | undefined {
    return reference.kind === "derivation" ? undefined : reference.path;
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
 * The inner markup of one artifact entry. An artifact entry names its path, and it adds the locator when
 * the reference pins one cell. A derivation entry names its operation and its two inputs, each by path and
 * locator.
 */
function ReferenceBody({ reference }: { reference: ArtifactReference }) {
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
 * One artifact entry: the body of its kind, and the chain of its path where the records hold one.
 *
 * A path that no record names renders the body alone, thus a page over pinned artifacts alone reads exactly
 * as it did before the chains existed.
 */
function ArtifactEntry({ reference, chains }: { reference: ArtifactReference; chains: DerivationChains | undefined }) {
    const path = pathOf(reference);
    const chain = path === undefined ? undefined : chains?.get(path);
    return (
        <>
            <ReferenceBody reference={reference} />
            {chain !== undefined ? <ChainLine chain={chain} /> : null}
        </>
    );
}

/**
 * The inner markup of one literature entry: the kind tag, the short citation of the pinned record, the key,
 * and the description of the record on a line of its own. A key that the record map does not hold shows the
 * key alone, because absence is a normal condition.
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
            <RefKind>Citation</RefKind>{" "}
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

/** One appendix entry. The kind of the reference selects the shape, and the two shapes share the ladder. */
function ReferenceEntry({ reference, records, chains }: { reference: Reference; records: CitationRecords | undefined; chains: DerivationChains | undefined }) {
    return reference.kind === "citation" ? <CitationEntry reference={reference} records={records} /> : <ArtifactEntry reference={reference} chains={chains} />;
}

/**
 * The one appendix list: one entry for each distinct reference of the page, in the order of the ladder.
 *
 * The list is an appendix: a reader consults one entry from a marker, thus the design keeps it quieter than
 * the body. The ordered list numbers its own items, thus the shown number of an entry matches the marker
 * that sent the reader to it. An empty ledger gives an empty string, thus the page shows no empty list.
 *
 * The records carry the bibliography of each cited key, and a ledger with no citation reads none of them.
 * The chains are the derivations of the session, keyed by the output path. An entry whose path the chains
 * hold carries the chain line, and each other entry carries none.
 */
export function renderReferences(ledger: ReferenceLedger, records?: CitationRecords, chains?: DerivationChains): string {
    const entries = ledger.entries();
    if (entries.length === 0) {
        return "";
    }
    return String(
        <ol class="report-references">
            {entries.map((reference, index) => (
                <li id={`ref-${index + 1}`} class="report-ref-item">
                    <ReferenceEntry reference={reference} records={records} chains={chains} />
                </li>
            ))}
        </ol>,
    );
}
