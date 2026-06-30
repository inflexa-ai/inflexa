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
        "Get known safety liabilities for a target from Open Targets. Returns organ-specific toxicity signals, adverse events, and safety-related phenotypes linked to the target.",
    inputSchema: z.object({
        ensemblId: z.string().describe("Ensembl gene ID (e.g. ENSG00000141510)"),
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
