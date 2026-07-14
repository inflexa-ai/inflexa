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

/** Per-action record caps, preserved from the five tools this one replaces. */
const LIMITS = {
    /** `compounds` / `bioactivity` — activity-scale reads. */
    wide: 500,
    /** `drug` / `targets` — resolution reads, where a long list is noise. */
    narrow: 25,
} as const;

const inputSchema = z
    .object({
        action: z
            .enum(["compounds", "drug", "mechanism", "bioactivity", "targets"])
            .describe(
                "Which ChEMBL lookup to run — each names the params it needs and the fields it returns.\n" +
                    "'compounds' (query + searchType) — molecules by target, name, or SMILES; resolves a named compound to its ChEMBL ID " +
                    "and structure, or lists the compounds assayed against a target. Returns chemblId, preferredCompoundName, " +
                    "canonicalSmiles, molecularWeight, alogp, molecularFormula.\n" +
                    "'drug' (query) — the drug registry by drug name or disease indication: 'what drugs treat X?', 'is Y approved, and " +
                    "since when?'. Returns moleculeChemblId, preferredName, maxPhase (4 = approved), moleculeType (small molecule, " +
                    "antibody, …), firstApproval year, indication. When the drug endpoint is empty it falls back to a molecule search " +
                    "filtered to max_phase >= 4; rows from that fallback carry indication: null.\n" +
                    "'mechanism' (chemblId) — the curated mechanism of action of ONE molecule: 'how does drug X work?'. Returns " +
                    "mechanismOfAction (prose), actionType (INHIBITOR, AGONIST, ANTAGONIST, …), targetChemblId + the resolved targetName, " +
                    "moleculeChemblId. ChEMBL curates mechanisms mainly for clinical/approved molecules, so tool compounds often have none.\n" +
                    "'bioactivity' (chemblId + idType) — measured activity rows (IC50, EC50, Ki, Kd, …): the curated, quotable potency " +
                    "data for a compound or a target. Returns standardType, standardValue + standardUnits, pchemblValue (normalized " +
                    "-log10 potency), assayChemblId, assayType, compoundChemblId, targetChemblId.\n" +
                    "'targets' (query) — resolve a gene symbol or protein name to a ChEMBL target: the step that produces the target ID " +
                    "used by bioactivity (idType='target') and compounds (searchType='target'). Returns targetChemblId, preferredName, " +
                    "targetType (SINGLE PROTEIN, PROTEIN COMPLEX, …), organism, geneNames. Results span organisms — check `organism` " +
                    "before using an ID, since the top hit for a human gene symbol may be a non-human ortholog.",
            ),
        query: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Required for 'compounds', 'drug', 'targets'. compounds: must match searchType — a target name/gene symbol or target " +
                    "ChEMBL ID, a compound name, or a SMILES string. drug: a drug name (e.g. 'imatinib') or a disease indication " +
                    "(e.g. 'melanoma'). targets: a gene symbol (e.g. 'EGFR', 'ABL1'), a protein name, or a ChEMBL target ID.",
            ),
        searchType: z
            .enum(["target", "compound", "smiles"])
            .optional()
            .describe(
                "Required for 'compounds' — how to read `query`. 'target': resolve it to a ChEMBL target, then return the compounds " +
                    "assayed against that target. 'compound': free-text search over molecule names. 'smiles': flexible (flexmatch) " +
                    "structure search on canonical SMILES.",
            ),
        chemblId: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Required for 'mechanism' and 'bioactivity'. A ChEMBL molecule ID (e.g. 'CHEMBL25' = aspirin) or — for bioactivity " +
                    "with idType='target' — a target ID (e.g. 'CHEMBL203' = EGFR). 'mechanism' takes a molecule ID only, never a target ID.",
            ),
        idType: z
            .enum(["compound", "target"])
            .optional()
            .describe(
                "Required for 'bioactivity' — which side of the activity table `chemblId` indexes. 'compound': chemblId is a molecule " +
                    "ID; returns everything that molecule was assayed against. 'target': chemblId is a target ID; returns every compound " +
                    "assayed against that target.",
            ),
        activityType: z
            .string()
            .optional()
            .describe(
                "'bioactivity' only. Exact ChEMBL standard_type filter, e.g. 'IC50', 'EC50', 'Ki', 'Kd'. Matched exactly " +
                    "(case-sensitive); omit to get all activity types.",
            ),
        limit: z
            .number()
            .int()
            .min(1)
            .max(LIMITS.wide)
            .optional()
            .describe(
                `Max records. 'compounds'/'bioactivity': 1–${LIMITS.wide} (default ${LIMITS.wide}). 'drug'/'targets': 1–${LIMITS.narrow} ` +
                    `(default ${LIMITS.narrow}). Ignored by 'mechanism'. With searchType='target' it caps the activity rows scanned, so ` +
                    `fewer unique compounds usually come back.`,
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
    .refine((d) => !(d.action === "drug" || d.action === "targets") || d.limit === undefined || d.limit <= LIMITS.narrow, {
        message: `limit is capped at ${LIMITS.narrow} for action 'drug' and 'targets' (only 'compounds' and 'bioactivity' reach ${LIMITS.wide})`,
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
        "ChEMBL — the manually curated database of drug-like bioactives (~2.4M compounds), the targets they were measured " +
        "against, their mechanisms, and their approval status. One tool, five lookups; pick with `action` (its description gives " +
        "each action's params and return fields).\n" +
        "IDs are resolved, never guessed: a `chemblId` comes from a prior action='compounds'/'drug' (molecule IDs) or action='targets' " +
        "(target IDs) call, or from pubchem action='crossrefs' — a compound or gene name is not a ChEMBL ID.\n" +
        "ChEMBL is curated, so prefer it over PubChem for anything you will quote or build on: use action='bioactivity' rather than " +
        "pubchem action='assays' whenever you will quote a number (PubChem assay summaries are broader HTS screening outcomes), and resolve " +
        "compounds here first. If ChEMBL does not find the compound, resolve it in PubChem with pubchem action='compound' and bridge back " +
        "to a ChEMBL ID via pubchem action='crossrefs'.\n" +
        "An empty array is a valid 'no match' / no-data answer, not an error — do not retry the same call.",
    inputSchema,
    execute: async ({ action, query, searchType, chemblId, idType, activityType, limit }): Promise<Result<ChemblOutput, ToolError>> => {
        switch (action) {
            case "compounds":
                return ok({ compounds: await searchCompounds(query!, searchType!, limit ?? LIMITS.wide) });
            case "drug":
                return ok({ drugs: await getDrugInfo(query!, limit ?? LIMITS.narrow) });
            case "mechanism":
                return ok({ mechanisms: await getMechanism(chemblId!) });
            case "bioactivity":
                return ok({ activities: await getBioactivity(chemblId!, idType!, { activityType, limit: limit ?? LIMITS.wide }) });
            case "targets":
                return ok({ targets: await searchTargets(query!, limit ?? LIMITS.narrow) });
        }
    },
});
