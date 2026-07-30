/**
 * chembl — one tool over the five ChEMBL lookups: compounds, drugs, mechanisms,
 * bioactivity, targets. "Which database" is the routing decision worth a tool
 * boundary; "which ChEMBL endpoint" is mechanical, so it rides in `action`.
 *
 * The input is a flat object with an `action` discriminator — not a
 * `z.discriminatedUnion`, which `defineTool` rejects (model tool calling needs a
 * top-level `"type":"object"`). Every per-action parameter is therefore optional
 * in the schema and made conditionally required by `.refine` instead: a
 * malformed call (a `mechanism` with no `chemblId`, a `bioactivity` with no
 * `idType`) fails validation at the loop boundary and comes back to the model as
 * an `is_error` tool result naming the missing field, without reaching `execute`.
 *
 * All request logic is the shared ChEMBL client (`tools/lib/chembl-client.ts`);
 * this file is the routing and the model-facing contract.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import type { ChemblActivity, ChemblCompound, ChemblDrug, ChemblMechanism, ChemblTarget } from "../lib/chembl-client.js";
import { defineTool, type ToolError } from "../define-tool.js";
import { getBioactivity, getDrugInfo, getMechanism, searchCompounds, searchTargets } from "../lib/chembl-client.js";

/**
 * Per-action record caps. The ceilings are what the endpoints will serve; the
 * defaults are deliberately far below them — 500 activity rows is ~125k
 * characters, which answers no question that the top 25 by potency does not.
 */
const LIMITS = {
    /** `compounds` / `bioactivity` — activity-scale reads. */
    wideMax: 500,
    wideDefault: 25,
    /** `drug` / `targets` — resolution reads, where a long list is noise. */
    narrowMax: 25,
    narrowDefault: 10,
} as const;

const inputSchema = z
    .object({
        action: z
            .enum(["compounds", "drug", "mechanism", "bioactivity", "targets"])
            .describe(
                "Which ChEMBL lookup to run; each names its params and return fields.\n" +
                    "'compounds' (query + searchType) — molecules by target, name or SMILES: resolve a named compound to its ID and structure, or list " +
                    "what was assayed against a target. → chemblId, preferredCompoundName, canonicalSmiles, molecularWeight, alogp, molecularFormula.\n" +
                    "'drug' (query) — the drug registry by drug name or indication: 'what treats X?', 'is Y approved, since when?'. → moleculeChemblId, " +
                    "preferredName, maxPhase (4 = approved), moleculeType, firstApproval, indication. If the drug endpoint is empty it falls back to a " +
                    "max_phase >= 4 molecule search, whose rows carry indication: null.\n" +
                    "'mechanism' (chemblId, molecule only) — curated mechanism of ONE molecule: 'how does X work?'. → mechanismOfAction, actionType " +
                    "(INHIBITOR, AGONIST, …), targetChemblId + targetName, moleculeChemblId. Curated mainly for clinical/approved molecules, so tool " +
                    "compounds often have none.\n" +
                    "'bioactivity' (chemblId + idType) — measured activity rows: the curated, QUOTABLE potency. → standardType, standardValue + " +
                    "standardUnits, pchemblValue (normalized -log10), assayChemblId, assayType, compoundChemblId, targetChemblId.\n" +
                    "'targets' (query) — resolve a gene symbol or protein name to a ChEMBL target, producing the ID that bioactivity (idType='target') " +
                    "and compounds (searchType='target') need. → targetChemblId, preferredName, targetType, organism, geneNames. Check `organism`: the " +
                    "top hit for a human symbol may be a non-human ortholog.",
            ),
        query: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Required for 'compounds', 'drug', 'targets'. compounds: must match searchType — a target name/gene symbol or target ChEMBL ID, a " +
                    "compound name, or a SMILES. drug: a drug name ('imatinib') or an indication ('melanoma'). targets: a gene symbol ('EGFR'), a " +
                    "protein name, or a ChEMBL target ID.",
            ),
        searchType: z
            .enum(["target", "compound", "smiles"])
            .optional()
            .describe(
                "Required for 'compounds' — how to read `query`. 'target': resolve to a ChEMBL target, then return what was assayed against it. " +
                    "'compound': free-text over molecule names. 'smiles': flexmatch structure search.",
            ),
        chemblId: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Required for 'mechanism' and 'bioactivity'. A molecule ID ('CHEMBL25' = aspirin), or — for bioactivity with idType='target' — a target " +
                    "ID ('CHEMBL203' = EGFR). 'mechanism' takes a molecule ID only.",
            ),
        idType: z
            .enum(["compound", "target"])
            .optional()
            .describe(
                "Required for 'bioactivity' — which side of the activity table `chemblId` indexes. 'compound': everything that molecule was assayed " +
                    "against. 'target': every compound assayed against that target.",
            ),
        activityType: z
            .string()
            .optional()
            .describe("'bioactivity' only. Exact, case-sensitive standard_type filter — 'IC50', 'EC50', 'Ki', 'Kd'. Omit for all types."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(LIMITS.wideMax)
            .optional()
            .describe(
                `Max records. 'compounds'/'bioactivity': 1–${LIMITS.wideMax} (default ${LIMITS.wideDefault}). 'drug'/'targets': 1–${LIMITS.narrowMax} ` +
                    `(default ${LIMITS.narrowDefault}). Ignored by 'mechanism'. Rows are UNSORTED, so raising this is the only way to widen the window — ` +
                    `do it to survey an SAR series or a full assay panel, not to browse. With searchType='target' it caps the activity rows scanned, so ` +
                    `fewer unique compounds come back.`,
            ),
    })
    .refine((d) => !(d.action === "compounds" || d.action === "drug" || d.action === "targets") || (d.query !== undefined && d.query.length > 0), {
        message: "query is required when action is 'compounds', 'drug', or 'targets'",
        path: ["query"],
    })
    .refine((d) => d.action !== "compounds" || d.searchType !== undefined, {
        message: "searchType is required when action is 'compounds' — 'target', 'compound', or 'smiles', matching what `query` holds",
        path: ["searchType"],
    })
    .refine((d) => !(d.action === "mechanism" || d.action === "bioactivity") || (d.chemblId !== undefined && d.chemblId.length > 0), {
        message:
            "chemblId is required when action is 'mechanism' or 'bioactivity' — a ChEMBL ID, not a name. " +
            "Resolve it first: action='compounds' or 'drug' for a molecule ID, action='targets' for a target ID.",
        path: ["chemblId"],
    })
    .refine((d) => d.action !== "bioactivity" || d.idType !== undefined, {
        message: "idType is required when action is 'bioactivity' — 'compound' if chemblId is a molecule ID, 'target' if it is a target ID",
        path: ["idType"],
    })
    .refine((d) => !(d.action === "drug" || d.action === "targets") || d.limit === undefined || d.limit <= LIMITS.narrowMax, {
        message: `limit is capped at ${LIMITS.narrowMax} for action 'drug' and 'targets' (only 'compounds' and 'bioactivity' reach ${LIMITS.wideMax})`,
        path: ["limit"],
    });

/** One result shape per action — the key names the records it carries. */
export type ChemblOutput =
    | { readonly compounds: ChemblCompound[] }
    | { readonly drugs: ChemblDrug[] }
    | { readonly mechanisms: ChemblMechanism[] }
    | { readonly activities: ChemblActivity[] }
    | { readonly targets: ChemblTarget[] };

export const chemblTool = defineTool({
    id: "chembl",
    description:
        "ChEMBL — the manually curated database of drug-like bioactives (~2.4M compounds), the targets they were measured against, their mechanisms and " +
        "their approval status. Five lookups; pick with `action`, which gives each one's params and return fields.\n" +
        "IDs are resolved, never guessed: a `chemblId` comes from a prior action='compounds'/'drug' (molecules) or action='targets' (targets), or from " +
        "pubchem action='crossrefs'. A compound or gene name is not a ChEMBL ID.\n" +
        "Being curated, ChEMBL is what you quote from: prefer action='bioactivity' over pubchem action='assays' for any number you will cite, and resolve " +
        "compounds here first. If ChEMBL misses the compound, resolve it via pubchem action='compound' and bridge back with pubchem action='crossrefs'.\n" +
        "An empty array is valid no-data, not an error — do not retry the same call.",
    inputSchema,
    execute: async ({ action, query, searchType, chemblId, idType, activityType, limit }): Promise<Result<ChemblOutput, ToolError>> => {
        switch (action) {
            case "compounds":
                return ok({ compounds: await searchCompounds(query!, searchType!, limit ?? LIMITS.wideDefault) });
            case "drug":
                return ok({ drugs: await getDrugInfo(query!, limit ?? LIMITS.narrowDefault) });
            case "mechanism":
                return ok({ mechanisms: await getMechanism(chemblId!) });
            case "bioactivity":
                return ok({ activities: await getBioactivity(chemblId!, idType!, { activityType, limit: limit ?? LIMITS.wideDefault }) });
            case "targets":
                return ok({ targets: await searchTargets(query!, limit ?? LIMITS.narrowDefault) });
        }
    },
});
