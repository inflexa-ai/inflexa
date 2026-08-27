/**
 * The data-script carrier of the provenance of one analysis.
 *
 * A `fetch` of a local file is refused on a `file://` page, thus the document cannot load the way an image
 * does. A classic script asset loads on any page, and it registers itself under one global when the browser
 * runs it. The carrier is the same one that a table payload uses.
 *
 * The document and the attestation are opaque text. This module reads no field of them, and it parses
 * nothing. Thus the format belongs to the writer of the document, and a change of that format costs no
 * change here.
 *
 * The document and the attestation ride separate assets, thus a new attestation over an unchanged document
 * rewrites the attestation alone. Each name carries the hash of its own bytes, thus two renders of one
 * document give one name and the sweep of the stage removes a name that the page does not reference.
 *
 * The module is pure, and it reads no file. The renderer derives an asset, and the caller writes it.
 */

import { createHash } from "node:crypto";

import { scriptJson } from "./script-json.js";
import type { DataAsset } from "./table-data.js";

/**
 * The one global that both assets register under.
 *
 * The page script reads the same name, thus the carrier and the reader cannot disagree over a rename.
 */
export const REPORT_PROVENANCE_GLOBAL = "__REPORT_PROV";

/** The member of the global that holds the document text. */
const DOCUMENT_MEMBER = "document";

/** The member of the global that holds the attestation text. */
const ATTESTATION_MEMBER = "attestation";

/** The count of hash characters in an asset name. It matches a table payload, thus one form reads across the directory. */
const HASH_CHARS = 12;

/**
 * The provenance that the page carries: the document text, and the attestation text where the source holds
 * one.
 *
 * Both are opaque strings. The renderer moves them into the page and never into a parse, thus a document of
 * any format rides unchanged and the page-side reader owns the format.
 */
export interface ProvenanceExport {
    readonly document: string;
    readonly attestation?: string;
}

/**
 * The source text of one member of the global.
 *
 * The global takes the null-prototype form, the same as the table registry, thus a member sits as an
 * ordinary entry. The text rides as a JSON string literal, thus hostile bytes are data and never source. A
 * `</script` sequence inside the text cannot close the element, because `scriptJson` writes each `<` as its
 * escape.
 */
function memberSource(member: string, text: string): string {
    const registry = `window.${REPORT_PROVENANCE_GLOBAL}`;
    return `${registry}=${registry}||Object.create(null);${registry}.${member}=${scriptJson(text)};\n`;
}

/** One member asset: the content-addressed file name under `suffix`, and the source text. */
function memberAsset(member: string, suffix: string, text: string): DataAsset {
    const bytes = memberSource(member, text);
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, HASH_CHARS);
    return { name: `prov-${hash}${suffix}`, bytes };
}

/**
 * The data assets of one provenance export, in load order.
 *
 * A source that holds no attestation gives the document asset alone. Thus an unsigned document still rides
 * the page, and the reader finds no attestation member on the global.
 */
export function provenanceDataAssets(provenance: ProvenanceExport): DataAsset[] {
    const assets = [memberAsset(DOCUMENT_MEMBER, ".data.js", provenance.document)];
    if (provenance.attestation !== undefined) {
        assets.push(memberAsset(ATTESTATION_MEMBER, ".sig.data.js", provenance.attestation));
    }
    return assets;
}
