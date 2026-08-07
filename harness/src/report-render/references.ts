/**
 * The reference ledger and the reference list.
 *
 * A claim binds to evidence, and a citation block points at an external source. The ledger collects each
 * reference in first-appearance order, and it gives one marker number to each distinct reference. A claim
 * marker and a citation marker read from the same ledger, thus one reference that two blocks share gets
 * one number and one list entry.
 *
 * Identity is the canonical serialization of the reference. `serializeReference` sorts the keys at every
 * depth, thus two references match only when every field matches. The key order of the source object does
 * not change the identity.
 */

import { serializeReference, type ArtifactValueReference, type Reference } from "../contracts/report-reference.js";
import { escapeHtml } from "./escape.js";

/**
 * The mutable ledger of references.
 *
 * The page walk makes one ledger, and it threads the ledger through each claim and each citation. The
 * order of the entries is the order of the first mark, thus the marker numbers count up by first
 * appearance.
 */
export class ReferenceLedger {
    private readonly order: Reference[] = [];
    private readonly markers = new Map<string, number>();

    /**
     * Give the marker number of a reference. A new reference gets the next number, and it joins the
     * order. A reference that matches an earlier one gives the earlier number, thus the list holds it one
     * time.
     */
    mark(reference: Reference): number {
        const key = serializeReference(reference);
        const seen = this.markers.get(key);
        if (seen !== undefined) {
            return seen;
        }
        const marker = this.order.length + 1;
        this.markers.set(key, marker);
        this.order.push(reference);
        return marker;
    }

    /** The references in first-appearance order. The marker of an entry is its position plus one. */
    entries(): readonly Reference[] {
        return this.order;
    }
}

/**
 * Render one evidence marker as a superscript that links to the list entry. The number comes from the
 * ledger as an integer, thus it needs no escape.
 */
export function renderMarker(marker: number): string {
    const n = String(marker);
    return `<sup class="report-marker font-mono text-[10px] text-primary-500"><a href="#ref-${n}">${n}</a></sup>`;
}

/**
 * Describe a locator as plain text: the column and the one row selector. The refine of the schema admits
 * exactly one of `row` or `rowFilter`, thus the two branches cover a valid locator. The caller escapes
 * the result before it enters the page.
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

/** Wrap a kind label. The label is a constant, and the escape stays for one uniform path. */
function kindLabel(text: string): string {
    return `<span class="report-ref-kind font-mono text-[11px] uppercase tracking-wider text-slate-400">${escapeHtml(text)}</span>`;
}

/** Wrap a path in a monospace code span. */
function pathCode(text: string): string {
    return `<code class="font-mono text-primary-700">${escapeHtml(text)}</code>`;
}

/** Wrap a plain detail such as a locator or an external id. */
function detailSpan(text: string): string {
    return `<span class="text-slate-500">${escapeHtml(text)}</span>`;
}

/**
 * Render the inner markup of one list entry. An artifact entry names its path, and it adds the locator
 * when the reference pins one cell. A citation entry names its identifier space and its id. A derivation
 * entry names its operation and its two inputs, each by path and locator.
 */
function renderReferenceEntry(reference: Reference): string {
    switch (reference.kind) {
        case "artifact-value":
            return `${kindLabel("Artifact value")} ${pathCode(reference.path)} ${detailSpan(describeLocator(reference.locator))}`;
        case "artifact-table":
            return `${kindLabel("Artifact table")} ${pathCode(reference.path)}`;
        case "artifact-file":
            return `${kindLabel("Artifact file")} ${pathCode(reference.path)}`;
        case "citation":
            return `${kindLabel("Citation")} ${detailSpan(`${reference.idKind}:${reference.id}`)}`;
        case "derivation": {
            const inputs = reference.inputs.map((input) => `${pathCode(input.path)} ${detailSpan(describeLocator(input.locator))}`).join(" and ");
            return `${kindLabel(`Derivation (${reference.op})`)} ${inputs}`;
        }
    }
}

/**
 * Render the ordered reference list for the end of the page. The list keeps the first-appearance order,
 * thus the ordinal of each item matches its marker. An empty ledger gives an empty string, thus the page
 * shows no empty list.
 */
export function renderReferenceList(ledger: ReferenceLedger): string {
    const entries = ledger.entries();
    if (entries.length === 0) {
        return "";
    }
    const items = entries.map((reference, index) => {
        const n = index + 1;
        return `<li id="ref-${n}" class="report-ref-item mb-2 text-sm text-slate-600">${renderReferenceEntry(reference)}</li>`;
    });
    return `<ol class="report-references list-decimal pl-6">\n${items.join("\n")}\n</ol>`;
}
