/**
 * getProteinDomains — the InterPro entries of one protein: its families,
 * domains, repeats, and sites, each with its residue ranges.
 *
 * The result is bounded on two axes: `limit` trims the entries, and
 * `maxLocations` trims the ranges of each entry. A repeat or an immunoglobulin
 * domain of a large protein matches hundreds of times (titin holds about 1,300
 * ranges), thus the ranges need their own bound.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { getProteinEntries, INTERPRO_MAX_PAGE_SIZE, type InterProProteinEntries } from "../lib/interpro-client.js";

const DEFAULTS = { limit: 50, maxLocations: 20 } as const;
const MAX_LOCATIONS = 1000;

export type GetProteinDomainsOutput = { uniprotAccession: string } & InterProProteinEntries;

/** The ok value. A script reads it as data, thus the catalog of `run_script` shows this type. */
const outputSchema = z.object({
    uniprotAccession: z.string(),
    domains: z.array(
        z.object({
            accession: z.string(),
            name: z.string(),
            type: z.string(),
            memberDatabases: z.record(z.string(), z.record(z.string(), z.string())),
            locations: z.array(z.object({ start: z.number(), end: z.number() })),
            locationCount: z.number(),
        }),
    ),
    totalFound: z.number(),
});

export const getProteinDomainsTool = defineTool({
    id: "get_protein_domains",
    concurrent: true,
    description:
        "InterPro — the families, domains, repeats, and sites of one protein, keyed by a UniProt accession ('P38398'). EMBL-EBI integrates the " +
        "signatures of Pfam, PROSITE, SMART, CDD, PANTHER, CATH-Gene3D, SUPERFAMILY, and the other member databases into one InterPro entry each " +
        "(Blum et al., NAR 2025), thus one call gives the domain architecture that each database gives only in part.\n" +
        "Each row is one InterPro entry: `accession` ('IPR001357'), `name` ('BRCT domain'), `type` (domain, family, homologous_superfamily, repeat, " +
        "conserved_site, active_site, binding_site, ptm), `memberDatabases` (database, then signature accession, then signature name: pfam, " +
        "PF00533, 'BRCA1 C Terminus (BRCT) domain'), and `locations`, the residue ranges of the match, 1-based and inclusive, in sequence order. " +
        "A discontinuous match gives one range for each fragment. The ranges are on the canonical UniProt sequence of the accession. To place a " +
        "variant, compare its residue position with the ranges only when its transcript encodes that canonical sequence: another isoform numbers " +
        "the residues differently, and the same gene or the same length does not prove the same sequence.\n" +
        "The rows are in the order of their first residue. `limit` is the size of the one page that InterPro serves, in the order of the InterPro accession, " +
        "and the tool sorts that page; `totalFound` gives the true count. `maxLocations` trims " +
        "the ranges of each row, and `locationCount` gives the true count: a repeat can match hundreds of times on a large protein such as titin.\n" +
        "IDENTIFIERS: a canonical UniProtKB accession. search_protein gives one for a gene symbol, and so does the `uniprot` field of a " +
        "resolve_gene_ids hit. An isoform accession ('P38398-2') or an entry name ('BRCA1_HUMAN') matches nothing.\n" +
        "An empty `domains` list is valid no-data: InterPro holds no entry for the accession, or it does not know the accession. Report it and " +
        "continue, do not retry.",
    inputSchema: z.object({
        uniprotAccession: z.string().trim().min(1).describe("A canonical UniProtKB accession, for example 'P38398' (BRCA1) or 'Q8WZ42' (titin)."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(INTERPRO_MAX_PAGE_SIZE)
            .optional()
            .describe(`Max InterPro entries returned (default ${DEFAULTS.limit}, max ${INTERPRO_MAX_PAGE_SIZE}).`),
        maxLocations: z
            .number()
            .int()
            .min(1)
            .max(MAX_LOCATIONS)
            .optional()
            .describe(`Max residue ranges returned for each entry (default ${DEFAULTS.maxLocations}, max ${MAX_LOCATIONS}).`),
    }),
    outputSchema,
    view: "none",
    describeCall: ({ uniprotAccession }) => uniprotAccession,
    execute: async ({ uniprotAccession, limit, maxLocations }): Promise<Result<GetProteinDomainsOutput, ToolError>> => {
        const entries = await getProteinEntries(uniprotAccession, {
            limit: limit ?? DEFAULTS.limit,
            maxLocations: maxLocations ?? DEFAULTS.maxLocations,
        });
        return ok({ uniprotAccession, ...entries });
    },
});
