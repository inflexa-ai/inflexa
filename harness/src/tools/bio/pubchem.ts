/**
 * pubchem — the single PubChem tool: compound resolution, registry
 * cross-references, and bioassay screening summaries behind one `action`
 * discriminator.
 *
 * The input is a flat object with an `action` discriminator — not a
 * `z.discriminatedUnion`, which `defineTool` rejects (the model needs a
 * top-level `"type":"object"`). Each action's own parameters are optional and
 * guarded by `.refine`, so a call that omits one (a 'crossrefs' with no `cid`)
 * fails at the loop boundary with a message naming the missing field, rather
 * than reaching an upstream request that cannot be built.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import {
    fetchPubchemAssays,
    fetchPubchemCompounds,
    fetchPubchemCrossRefs,
    type PubChemAssay,
    type PubChemCompound,
    type PubChemCrossRef,
} from "../lib/pubchem-ops.js";

const inputSchema = z
    .object({
        action: z
            .enum(["compound", "crossrefs", "assays"])
            .describe(
                "Which PubChem lookup to run. " +
                    "'compound' — resolve `query` (in the namespace named by `searchBy`) to a compound. Returns results[]: identity (cid, canonicalSmiles, inchi, inchiKey, iupacName, " +
                    "molecularFormula) and computed properties (molecularWeight, xlogp, tpsa, hbondDonorCount, hbondAcceptorCount, rotatableBondCount, complexity). " +
                    "'crossrefs' — external registry ids for a `cid`. Returns crossRefs[]: a flat list of { source, id } entries. `source` names the registry that the id pattern " +
                    "identifies — ChEMBL, ChEBI, DrugBank, KEGG, HMDB, CAS, PDB or UNII — and it is null for an id of any other registry; filter by `source` for the one you want. " +
                    "This is the bridge out of PubChem. " +
                    "'assays' — bioassay screening summaries for a `cid`; answers 'has this compound ever been screened, and against what?'. Returns assays[]: aid, assayName, targetName " +
                    "(the target accession, for example a UniProt or PDB id), " +
                    "activityOutcome (Active / Inactive / Inconclusive / Unspecified), activityValue. Broad HTS screening coverage, NOT curated potency — for numbers you intend to quote " +
                    "(IC50/Ki), prefer chembl action='bioactivity'.",
            ),
        query: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Required for action 'compound'. The identifier itself; its form must match `searchBy` (a name, a SMILES string, an InChI, an InChIKey, or a numeric CID).",
            ),
        searchBy: z
            .enum(["name", "smiles", "inchi", "inchikey", "cid"])
            .optional()
            .describe(
                "Required for action 'compound'. Which PubChem namespace `query` is expressed in. All are exact-match lookups except 'name', which tolerates synonyms and trade names.",
            ),
        cid: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
                "Required for actions 'crossrefs' and 'assays'. PubChem Compound ID as an integer (e.g. 2244 for aspirin), from a prior action 'compound' call.",
            ),
        activeOnly: z
            .boolean()
            .optional()
            .describe(
                "Action 'assays' only. Default TRUE — only rows whose activityOutcome is 'Active'. A widely screened compound has thousands of " +
                    "inactive rows and they answer nothing on their own; set false only when a LOW hit rate is the finding you are after (selectivity, " +
                    "or confirming a compound was tested and came back clean).",
            ),
        limit: z
            .number()
            .int()
            .min(1)
            .max(500)
            .optional()
            .describe("Action 'assays' only. Max assay records to return (default 25, max 500). Applied after the activeOnly filter."),
    })
    .refine((d) => d.action !== "compound" || (d.query !== undefined && d.query.trim().length > 0), {
        message: "query is required when action is 'compound' — the identifier to resolve (a name, SMILES, InChI, InChIKey, or CID)",
        path: ["query"],
    })
    .refine((d) => d.action !== "compound" || d.searchBy !== undefined, {
        message: "searchBy is required when action is 'compound' — name | smiles | inchi | inchikey | cid, matching the form of `query`",
        path: ["searchBy"],
    })
    .refine((d) => (d.action !== "crossrefs" && d.action !== "assays") || d.cid !== undefined, {
        message: "cid is required when action is 'crossrefs' or 'assays' — resolve the compound with action 'compound' first and copy its cid",
        path: ["cid"],
    });

type PubchemOutput = { results: PubChemCompound[] } | { crossRefs: PubChemCrossRef[] } | { assays: PubChemAssay[] };

export const pubchemTool = defineTool({
    id: "pubchem",
    description:
        "Query PubChem — the open chemical database of the NCBI, with over 110M compounds and their BioAssay screening records. Pick the lookup with " +
        "`action`: 'compound' (resolve an identifier), 'crossrefs' (external registry ids for a CID), 'assays' (bioassay screening summaries for a CID). " +
        "See `action` for what each returns. " +
        "ACCEPTED IDENTIFIERS: for 'compound', the form named by `searchBy` — a chemical name ('aspirin'), a SMILES string, an InChI, an InChIKey " +
        "('BSYNRYMUTXBXSQ-UHFFFAOYSA-N') or a numeric CID ('2244'). 'crossrefs' and 'assays' take the numeric CID only. " +
        "Reach for PubChem when ChEMBL misses the compound — it covers metabolites, vendor chemicals, food additives and environmental compounds that ChEMBL does not. " +
        "PubChem carries no curated mechanism or potency data, so resolve broadly HERE and then bridge OUT: action 'compound' to get the cid, action 'crossrefs' to take its ChEMBL ID, " +
        "then chembl action='mechanism' / 'bioactivity' there for curated activity data. " +
        "An empty results / crossRefs / assays array is valid no-data (no match; the CID is in no external registry; the compound was never screened) — do not retry.",
    inputSchema,
    describeCall: "none",
    execute: async (input) => {
        switch (input.action) {
            case "compound":
                return ok<PubchemOutput>({ results: await fetchPubchemCompounds(input.query!, input.searchBy!) });
            case "crossrefs":
                return ok<PubchemOutput>({ crossRefs: await fetchPubchemCrossRefs(input.cid!) });
            case "assays":
                return ok<PubchemOutput>({
                    assays: await fetchPubchemAssays(input.cid!, {
                        activeOnly: input.activeOnly ?? true,
                        limit: input.limit ?? 25,
                    }),
                });
        }
    },
});
