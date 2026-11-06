/**
 * Pure async client functions for InterPro (EMBL-EBI), which integrates the
 * protein signatures of Pfam, PROSITE, SMART, CDD, PANTHER, CATH-Gene3D,
 * SUPERFAMILY, and the other member databases into one entry for each family,
 * domain, repeat, or site (Blum et al., NAR 2025).
 *
 * Absence policy: InterPro keeps the key of an absent value and sends an
 * explicit `null` — `integrated` and `go_terms` of an entry, `model` and `score`
 * of a location. Thus a maybe-absent field carries `.nullable()`, not
 * `.optional()`. The client reads none of those fields.
 *
 * InterPro answers an accession that matches no entry with HTTP 204 and an empty
 * body: an unknown accession, an isoform accession, an entry name, or a protein
 * that no signature matches. `apiFetch` parses a JSON body after any 2xx, and
 * the parse of an empty body throws, which it retries until it is exhausted.
 * Thus the client reads the body as text, gives the empty result for an empty
 * body, and validates a non-empty body itself. A malformed accession gets an
 * HTTP 404, which is an absence too. Each other status is an unexpected failure.
 *
 * The 204 also declares `Content-Length: 119`. An HTTP/1.1 fetch (Bun, and Node
 * 24) reads the 204. The HTTP/2 fetch of Node 26 refuses that header as a
 * protocol error before a status exists, thus there the call fails in transport
 * and the tool reports an error. A transport failure is never read as an
 * absence.
 *
 * The first request for an accession that InterPro has not cached can answer
 * HTTP 503. `apiFetch` retries it.
 *
 * InterPro asks for no key and no caller identity. The shared
 * `HARNESS_USER_AGENT` of `apiFetch` names the caller.
 */

import { z } from "zod";

import { safeParseJsonAs } from "../../lib/parse-json.js";
import { apiFetchText, describeApiError } from "./api-utils.js";

const INTERPRO_BASE = "https://www.ebi.ac.uk/interpro/api";

/** The largest page that the client asks for. */
export const INTERPRO_MAX_PAGE_SIZE = 200;

/** One residue range of a match, 1-based and inclusive. */
export type InterProRange = { start: number; end: number };

export type InterProEntry = {
    /** The InterPro accession: 'IPR001357'. */
    accession: string;
    name: string;
    /** 'domain', 'family', 'homologous_superfamily', 'repeat', 'conserved_site', 'active_site', 'binding_site', or 'ptm'. */
    type: string;
    /** The signatures that the entry integrates: member database, then signature accession, then signature name. */
    memberDatabases: Record<string, Record<string, string>>;
    /** The ranges of the match on the protein, in sequence order. One range for each fragment of a location. */
    locations: InterProRange[];
    /** The range count before `maxLocations`. */
    locationCount: number;
};

export type InterProProteinEntries = {
    domains: InterProEntry[];
    /** The entry count of InterPro for the protein, before `limit`. */
    totalFound: number;
};

const FragmentSchema = z.object({
    start: z.number().int(),
    end: z.number().int(),
});

const EntryProteinSchema = z.object({
    entry_protein_locations: z.array(z.object({ fragments: z.array(FragmentSchema) })),
});

/** One row of `results`, with each fragment of each location as one range in sequence order. */
export const InterProEntryRowSchema = z
    .object({
        metadata: z.object({
            accession: z.string(),
            name: z.string(),
            type: z.string(),
            member_databases: z.record(z.string(), z.record(z.string(), z.string())),
        }),
        proteins: z.array(EntryProteinSchema),
    })
    .transform((d): InterProEntry => {
        const locations = d.proteins
            .flatMap((protein) => protein.entry_protein_locations.flatMap((location) => location.fragments))
            .map((fragment) => ({ start: fragment.start, end: fragment.end }))
            .sort((a, b) => a.start - b.start || a.end - b.end);
        return {
            accession: d.metadata.accession,
            name: d.metadata.name,
            type: d.metadata.type,
            memberDatabases: d.metadata.member_databases,
            locations,
            locationCount: locations.length,
        };
    });

/** The body of `GET /api/entry/interpro/protein/uniprot/{accession}/`. `count` is the true total of the pages. */
export const InterProEntryPageSchema = z.object({
    count: z.number().int().nonnegative(),
    results: z.array(InterProEntryRowSchema),
});

/** The first residue of an entry, for the sequence order. An entry with no range goes last. */
function firstResidue(entry: InterProEntry): number {
    return entry.locations[0]?.start ?? Number.MAX_SAFE_INTEGER;
}

/**
 * The InterPro entries that match one UniProtKB accession, in the order of their
 * first residue. `limit` is the page size, thus the client reads one page and
 * `totalFound` reports the true count. `maxLocations` trims the ranges of each
 * entry, and `locationCount` reports the true count.
 *
 * Gives an empty list for an HTTP 204 or an HTTP 404: no entry matches the
 * accession, or InterPro does not know it.
 */
export async function getProteinEntries(accession: string, options: { limit?: number; maxLocations?: number } = {}): Promise<InterProProteinEntries> {
    const params = new URLSearchParams({ page_size: String(options.limit ?? INTERPRO_MAX_PAGE_SIZE) });
    const res = await apiFetchText(`${INTERPRO_BASE}/entry/interpro/protein/uniprot/${encodeURIComponent(accession)}/?${params}`);
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return { domains: [], totalFound: 0 };
        throw new Error(describeApiError(res.error));
    }
    if (res.value.trim() === "") return { domains: [], totalFound: 0 };
    const parsed = safeParseJsonAs(res.value, InterProEntryPageSchema);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`).join("; ");
        throw new Error(describeApiError({ type: "invalid_response", issues }));
    }
    const maxLocations = options.maxLocations ?? Number.POSITIVE_INFINITY;
    const domains = parsed.data.results
        .sort((a, b) => firstResidue(a) - firstResidue(b))
        .map((entry) => ({ ...entry, locations: entry.locations.slice(0, maxLocations) }));
    return { domains, totalFound: parsed.data.count };
}
