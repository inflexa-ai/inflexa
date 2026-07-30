/**
 * Zod schema for the token-usage rollup — validation at boundaries.
 */

import { z } from "zod";

import type { TokenUsageField } from "../usage.js";

/**
 * One reported count. Token counts are whole tokens and cannot run negative, so
 * the schema rejects fractions and negatives rather than passing them through as
 * plain numbers. Optional throughout: absent means "not reported", never zero.
 */
const tokenCount = z.number().int().nonnegative().optional();

export const TokenUsageRollupSchema = z.object({
    inputTokens: tokenCount,
    outputTokens: tokenCount,
    cacheCreationInputTokens: tokenCount,
    cacheReadInputTokens: tokenCount,
    reasoningTokens: tokenCount,
});

// The schema validates exactly the rollup's fields — no more, no less. The guard
// lives here rather than beside the other field-set assertions (which sit at the
// declarations outside `contracts/`) because both halves of this one are already
// in `contracts/`: pinning a schema to its own module's constant adds no
// dependency, and a rule missing for a newly added count is a validation hole,
// not a compile error, without it.
type SchemaField = keyof z.infer<typeof TokenUsageRollupSchema>;
type _AssertSchemaFields = Exclude<SchemaField, TokenUsageField> | Exclude<TokenUsageField, SchemaField> extends never ? true : never;
const _assertSchemaFields: _AssertSchemaFields = true;
