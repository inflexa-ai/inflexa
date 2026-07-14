/**
 * opentargets — one tool over the Open Targets Platform: target-disease
 * association evidence (from a gene or from a disease) and the target's
 * curated safety liabilities.
 *
 * The input is a flat object with an `action` discriminator — not a
 * `z.discriminatedUnion`, which `defineTool` rejects (model tool calling needs
 * a top-level `"type":"object"`). Each action's identifier is optional in the
 * schema and enforced by `.refine`, so a call that omits it fails at the loop
 * boundary with an actionable message instead of reaching the API.
 *
 * The identifier fields are deliberately separate (`ensemblId` / `efoId`)
 * rather than one polymorphic `query`: Open Targets accepts ONLY an Ensembl
 * gene ID or an EFO disease ID, and a gene symbol silently returns an empty
 * result rather than an error. Naming the two identifiers apart is what makes
 * that contract visible at the call site.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import {
    getTargetSafetyLiabilities,
    searchDiseaseAssociations,
    searchTargetAssociations,
    type Association,
    type SafetyLiability,
    type TargetInfo,
} from "../lib/opentargets-client.js";

const inputSchema = z
    .object({
        action: z
            .enum(["target", "disease", "safety"])
            .describe(
                "'target' (needs ensemblId) — the diseases associated with the gene: targetInfo (approvedSymbol, approvedName, " +
                    "tractability across small molecule / antibody / other modalities) plus associations[], each with an overall score and " +
                    "its per-datatype breakdown — genetic association, known drug, literature, animal model, somatic mutation. " +
                    "'disease' (needs efoId) — the targets ranked for that disease; each association carries targetId/targetSymbol/targetName " +
                    "and the same score breakdown. " +
                    "'safety' (needs ensemblId) — the target's curated safety liabilities: found: true with targetSymbol and " +
                    "safetyLiabilities[] { event, biosamples (affected tissues), effects (direction of effect), source }. This is TARGET-level, " +
                    "mechanism-based safety — for the post-market adverse events of a specific marketed DRUG use search_faers instead.",
            ),
        ensemblId: z.string().optional().describe("Ensembl gene ID, e.g. ENSG00000141510 (TP53). Required for action 'target' and 'safety'."),
        efoId: z.string().optional().describe("EFO disease ID, e.g. EFO_0000311. Required for action 'disease'."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .default(25)
            .optional()
            .describe("Max associations to return (default 25, max 100), ordered by descending association score. Ignored by 'safety'."),
    })
    .refine((d) => d.action === "disease" || (d.ensemblId !== undefined && d.ensemblId.trim().length > 0), {
        message:
            "ensemblId is required when action is 'target' or 'safety' — Open Targets accepts only Ensembl gene IDs (ENSG…), " +
            "never gene symbols. Resolve the symbol to an ENSG id with search_gene, then retry.",
        path: ["ensemblId"],
    })
    .refine((d) => d.action !== "disease" || (d.efoId !== undefined && d.efoId.trim().length > 0), {
        message: "efoId is required when action is 'disease' — Open Targets accepts only EFO disease IDs (e.g. EFO_0000311), never free-text disease names.",
        path: ["efoId"],
    });

type OpenTargetsOutput =
    | { targetInfo: TargetInfo | null; associations: Association[] }
    | { associations: Association[] }
    | { found: false; ensemblId: string }
    | { found: true; targetSymbol: string; safetyLiabilities: SafetyLiability[] };

export const openTargetsTool = defineTool({
    id: "opentargets",
    description:
        "Query the Open Targets Platform — the preferred FIRST call for target assessment, since one 'target' query yields the " +
        "genetic evidence, tractability, and drug landscape together, and 'safety' adds the mechanism-based liabilities. See the " +
        "action parameter for what each mode needs and returns.\n" +
        "IDENTIFIERS ONLY: it accepts an Ensembl gene ID (action 'target'/'safety') or an EFO disease ID (action 'disease'). A bare " +
        "gene symbol or a free-text disease name silently returns an EMPTY result rather than an error — resolve a symbol to its ENSG " +
        "id with search_gene first.\n" +
        "NO-DATA IS FINAL — do not retry the same id. Empty associations mean no evidence (or an unresolvable id); safety found: false " +
        "means no Open Targets record for that Ensembl id (usually a wrong id); safety found: true with an empty safetyLiabilities " +
        "array means no curated liability.",
    inputSchema,
    execute: async (input): Promise<Result<OpenTargetsOutput, ToolError>> => {
        switch (input.action) {
            case "target": {
                const targetInfo = await searchTargetAssociations(input.ensemblId!, input.limit);
                return ok({ targetInfo, associations: targetInfo?.associations ?? [] });
            }
            case "disease": {
                const associations = await searchDiseaseAssociations(input.efoId!, input.limit);
                return ok({ associations });
            }
            case "safety": {
                const result = await getTargetSafetyLiabilities(input.ensemblId!);
                // "Target not found" is an expected outcome — a data variant, not an error.
                if (!result) return ok({ found: false as const, ensemblId: input.ensemblId! });
                return ok({
                    found: true as const,
                    targetSymbol: result.targetSymbol,
                    safetyLiabilities: result.safetyLiabilities,
                });
            }
        }
    },
});
