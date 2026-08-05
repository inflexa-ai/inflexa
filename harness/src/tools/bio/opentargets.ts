/**
 * opentargets — one tool over the Open Targets Platform: target-disease
 * association evidence, read from a gene or from a disease.
 *
 * The curated safety liabilities this tool used to serve now belong to
 * `target_safety`, which pairs them with the local secondary-pharmacology panel
 * and resolves the Ensembl id they need.
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
import { searchDiseaseAssociations, searchTargetAssociations, type Association, type TargetInfo } from "../lib/opentargets-client.js";

const DEFAULT_LIMIT = 10;

const inputSchema = z
    .object({
        action: z
            .enum(["target", "disease"])
            .describe(
                "'target' (needs ensemblId) — the diseases associated with the gene: targetInfo (approvedSymbol, approvedName, " +
                    "tractability across small molecule / antibody / other modalities) plus associations[], each with an overall score and " +
                    "its per-datatype breakdown — genetic association, known drug, literature, animal model, somatic mutation. " +
                    "'disease' (needs efoId) — the targets ranked for that disease; each association carries targetId/targetSymbol/targetName " +
                    "and the same score breakdown.",
            ),
        ensemblId: z.string().optional().describe("Ensembl gene ID, e.g. ENSG00000141510 (TP53). Required for action 'target'."),
        efoId: z.string().optional().describe("EFO disease ID, e.g. EFO_0000311. Required for action 'disease'."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe(
                `Max associations to return (default ${DEFAULT_LIMIT}, max 100), ordered by DESCENDING association score. The default is the top ` +
                    `${DEFAULT_LIMIT}, which is where the evidence is; raise it only when you are surveying the long tail rather than ranking.`,
            ),
    })
    .refine((d) => d.action !== "target" || (d.ensemblId !== undefined && d.ensemblId.trim().length > 0), {
        message:
            "ensemblId is required when action is 'target' — Open Targets accepts only Ensembl gene IDs (ENSG…), " +
            "never gene symbols. Resolve the symbol to an ENSG id with search_gene, then retry.",
        path: ["ensemblId"],
    })
    .refine((d) => d.action !== "disease" || (d.efoId !== undefined && d.efoId.trim().length > 0), {
        message: "efoId is required when action is 'disease' — Open Targets accepts only EFO disease IDs (e.g. EFO_0000311), never free-text disease names.",
        path: ["efoId"],
    });

type OpenTargetsOutput = { targetInfo: TargetInfo | null; associations: Association[] } | { associations: Association[] };

export const openTargetsTool = defineTool({
    id: "opentargets",
    description:
        "Query the Open Targets Platform — the preferred FIRST call for target assessment, since one 'target' query yields the genetic evidence, " +
        "tractability, and drug landscape together, already scored and ranked. See the action parameter for what each mode needs and returns.\n" +
        "It is the integrated view; the underlying records live elsewhere. For the raw genetic evidence (individual SNPs, effect sizes, GDA scores, " +
        "variant pathogenicity) use gene_disease_evidence. For this target's mechanism-based safety liabilities use target_safety.\n" +
        "IDENTIFIERS ONLY: it accepts an Ensembl gene ID (action 'target') or an EFO disease ID (action 'disease'). A bare gene symbol or a free-text " +
        "disease name silently returns an EMPTY result rather than an error — resolve a symbol to its ENSG id with search_gene first.\n" +
        "NO-DATA IS FINAL — do not retry the same id. Empty associations mean no evidence, or an unresolvable id.",
    inputSchema,
    describeCall: "none",
    execute: async (input): Promise<Result<OpenTargetsOutput, ToolError>> => {
        const limit = input.limit ?? DEFAULT_LIMIT;
        switch (input.action) {
            case "target": {
                const targetInfo = await searchTargetAssociations(input.ensemblId!, limit);
                return ok({ targetInfo, associations: targetInfo?.associations ?? [] });
            }
            case "disease": {
                const associations = await searchDiseaseAssociations(input.efoId!, limit);
                return ok({ associations });
            }
        }
    },
});
