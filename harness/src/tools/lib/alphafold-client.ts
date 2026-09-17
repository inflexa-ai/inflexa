/**
 * Pure async client functions for the AlphaFold Protein Structure Database
 * (AlphaFold DB) prediction API. Keyless and public: one unauthenticated GET,
 * keyed by a UniProt accession.
 *
 * Absence policy: AlphaFold DB omits the key of an absent value — the
 * AlphaMissense annotation URLs (`amAnnotationsUrl` and its two genome-build
 * siblings) ride on the AlphaMissense proteome-wide predictions, which cover
 * the human proteome only. A canonical accession of a different organism
 * carries no such URL, and neither does an isoform entry of any organism —
 * thus a maybe-absent field carries `.optional()`, not `.nullable()`.
 *
 * Not-found semantics: AlphaFold splits absence over two status codes. An
 * identifier that does not parse as a UniProt accession or an AlphaFold DB id
 * gives 400 with an `Invalid identifier format` body. A well-formed accession
 * that AlphaFold holds no model for gives 404 with an empty object. Both are
 * the same outcome for a caller, thus one branch answers both. Only these two
 * codes mean absence. A different 4xx, such as a 403 refusal, throws, because
 * `found: false` tells the agent to report the absence and not to retry.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError, type ApiError } from "./api-utils.js";

const ALPHAFOLD_BASE = "https://alphafold.ebi.ac.uk/api/prediction";

/**
 * One entry of the AlphaFold DB prediction array. A query by a canonical
 * accession can answer with more than one entry — one per UniProt isoform —
 * thus the schema is `z.array(...)` and the client selects the entry that
 * matches the queried accession.
 */
export const AlphaFoldPredictionSchema = z.object({
    uniprotAccession: z.string(),
    uniprotDescription: z.string(),
    latestVersion: z.number(),
    modelCreatedDate: z.string(),
    globalMetricValue: z.number(),
    fractionPlddtVeryLow: z.number(),
    fractionPlddtLow: z.number(),
    fractionPlddtConfident: z.number(),
    fractionPlddtVeryHigh: z.number(),
    pdbUrl: z.url(),
    cifUrl: z.url(),
    paeImageUrl: z.url(),
    // The per-residue confidence document. `globalMetricValue` and the
    // `fractionPlddt*` fractions describe the whole chain, thus this URL is the
    // only field that tells a caller *which* residues are disordered.
    plddtDocUrl: z.url(),
    paeDocUrl: z.url(),
    amAnnotationsUrl: z.url().optional(),
});

export type AlphaFoldPrediction = z.infer<typeof AlphaFoldPredictionSchema>;

/**
 * Fetch the AlphaFold structure prediction for one UniProt accession.
 *
 * Gives `null` when AlphaFold holds no model for the accession, and `null` for
 * an identifier it cannot parse. Throws on each other failure. When the array
 * holds more than one entry —
 * the isoforms of one canonical accession — the entry whose own
 * `uniprotAccession` matches the queried accession wins. A query that names no
 * exact isoform falls back to the first entry, which AlphaFold orders
 * canonical-first.
 */
export async function fetchAlphaFoldPrediction(uniprotAccession: string): Promise<AlphaFoldPrediction | null> {
    const accession = uniprotAccession.trim();
    const res = await apiFetchValidated(`${ALPHAFOLD_BASE}/${encodeURIComponent(accession)}`, z.array(AlphaFoldPredictionSchema));

    if (res.isErr()) {
        if (isAbsence(res.error)) return null;
        throw new Error(describeApiError(res.error));
    }

    const entries = res.value;
    if (entries.length === 0) return null;

    const exact = entries.find((entry) => entry.uniprotAccession.toUpperCase() === accession.toUpperCase());
    return exact ?? entries[0]!;
}

function isAbsence(e: ApiError): boolean {
    return e.type === "http_status" && (e.status === 400 || e.status === 404);
}
