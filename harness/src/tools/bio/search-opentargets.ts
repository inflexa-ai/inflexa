/**
 * searchOpenTargets — query Open Targets Platform for target-disease
 * associations, genetic evidence, tractability, and known drug scores.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { searchDiseaseAssociations, searchTargetAssociations } from "../lib/opentargets-client.js";

export const searchOpenTargetsTool = defineTool({
    id: "search_opentargets",
    description:
        "Query the Open Targets Platform for target-disease association evidence — the first stop for target assessment, since one call returns the ranked associations plus, in target " +
        "mode, the target's tractability (small molecule, antibody, other modalities). " +
        "Each association carries an overall score and its per-datatype breakdown: genetic association, known drug, literature, animal model, and somatic mutation. " +
        "It accepts ONLY Ensembl gene IDs and EFO disease IDs — a gene symbol or a disease name silently returns an empty result, so resolve symbols to ENSG with search_gene first. " +
        "Empty associations mean no evidence (or an unresolvable ID) — do not retry with the same ID. Use get_target_safety for the target's safety liabilities.",
    inputSchema: z.object({
        query: z
            .string()
            .describe(
                "Ensembl gene ID (ENSG…, e.g. ENSG00000141510 for TP53) when searchType='target'; EFO disease ID (e.g. EFO_0000311) when searchType='disease'. " +
                    "Gene symbols and free-text disease names are NOT accepted — they return nothing.",
            ),
        searchType: z
            .enum(["target", "disease"])
            .describe(
                "'target' — diseases associated with the gene, plus targetInfo and tractability. 'disease' — targets ranked for the disease (each association carries targetId/targetSymbol/targetName).",
            ),
        limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .default(25)
            .describe("Max associations to return (default 25, max 100), ordered by descending association score."),
    }),
    execute: async ({ query, searchType, limit = 25 }) => {
        if (searchType === "target") {
            const targetInfo = await searchTargetAssociations(query, limit);
            return ok({ targetInfo, associations: targetInfo?.associations ?? [] });
        }
        const associations = await searchDiseaseAssociations(query, limit);
        return ok({ associations });
    },
});
