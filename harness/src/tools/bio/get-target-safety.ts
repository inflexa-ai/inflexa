/**
 * getTargetSafety — fetch known safety liabilities for a target from
 * Open Targets.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { getTargetSafetyLiabilities } from "../lib/opentargets-client.js";

type SafetyLiabilities = NonNullable<Awaited<ReturnType<typeof getTargetSafetyLiabilities>>>["safetyLiabilities"];

type GetTargetSafetyOutput =
    | { found: false; ensemblId: string }
    | {
          found: true;
          targetSymbol: string;
          safetyLiabilities: SafetyLiabilities;
      };

export const getTargetSafetyTool = defineTool({
    id: "get_target_safety",
    description:
        "Get Open Targets' curated safety liabilities for a target — the known toxicity signals attached to modulating the gene itself, used to de-risk a target before committing to it. " +
        "On a hit returns found: true with targetSymbol and safetyLiabilities[]: { event, biosamples (affected tissues), effects (direction of effect), source }. " +
        "This is TARGET-level (mechanism-based) safety; for post-market adverse events of a specific marketed drug use search_faers instead. " +
        "Takes an Ensembl gene ID only — resolve a gene symbol with search_gene first. " +
        "found: false means no Open Targets record for that Ensembl ID (usually a wrong ID); found: true with an empty safetyLiabilities array means no curated liability. Both are valid no-data — do not retry.",
    inputSchema: z.object({
        ensemblId: z.string().describe("Ensembl gene ID (ENSG…, e.g. ENSG00000141510 for TP53). Gene symbols are not accepted."),
    }),
    execute: async ({ ensemblId }): Promise<Result<GetTargetSafetyOutput, ToolError>> => {
        const result = await getTargetSafetyLiabilities(ensemblId);
        // "Target not found" is an expected outcome — a data variant, not an error.
        if (!result) return ok({ found: false as const, ensemblId });
        return ok({
            found: true as const,
            targetSymbol: result.targetSymbol,
            safetyLiabilities: result.safetyLiabilities,
        });
    },
});
