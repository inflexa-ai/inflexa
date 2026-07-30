/**
 * Zod schema for the token-usage rollup — validation at boundaries.
 */

import { z } from "zod";

export const TokenUsageRollupSchema = z.object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cacheCreationInputTokens: z.number().optional(),
    cacheReadInputTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
});
