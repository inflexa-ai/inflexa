/**
 * Token-usage rollups on the Cortex wire vocabulary.
 *
 * A rollup is the sum of what providers reported across some set of LLM calls
 * — one agent loop, one whole turn, one run step. It is declared here, and not
 * imported from the provider seam, because `contracts/` is the sole
 * Cortex↔consumer wire contract and must stay free of the harness's own
 * dependencies: a frontend importing these types should not inherit a
 * typecheck dependency on the AI SDK.
 *
 * Every field is optional and absent means "not reported" — never zero. A set
 * of calls that reported nothing carries no rollup at all rather than an
 * all-zero one, so a consumer can tell "spent nothing" from "was told nothing".
 */

export interface TokenUsageRollup {
    /** Total billed prefix, cache reads included. */
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    /** Prefix tokens written into the provider's prompt cache. */
    readonly cacheCreationInputTokens?: number;
    /** Prefix tokens served from the provider's prompt cache. */
    readonly cacheReadInputTokens?: number;
    /**
     * Exactly what the provider reported — never derived from, nor reconciled
     * against, `outputTokens`. Whether reasoning tokens sit inside the output
     * total varies by provider, so arithmetic between the two is a guess.
     */
    readonly reasoningTokens?: number;
}

/**
 * The rollup's fields as values — the single enumeration a fold can iterate.
 *
 * This shape is declared four times over: here, on the provider seam's
 * `ChatUsage`, on the loop's mutable `AgentRunUsage`, and on the Zod schema
 * beside this file. Nothing but this list joins them, and it is deliberately
 * the *only* thing that does: `contracts/` is the Cortex↔consumer wire
 * vocabulary and must not import the loop, the providers, or the AI SDK, so a
 * shared base type is not available to it. What is available is a
 * dependency-free constant every side may import — the loop folds by iterating
 * it (`loop/metrics.ts:addChatUsage`), and the declarations that cannot be
 * expressed in terms of it are pinned to it by key-set assertions at their own
 * sites, which is why adding a sixth count in one place fails `tsc` instead of
 * silently going unfolded.
 *
 * `satisfies` rejects a name that is not a field; the assertion below rejects a
 * field that is not named. Both directions are needed — either alone leaves one
 * kind of drift compiling.
 */
export const TOKEN_USAGE_FIELDS = [
    "inputTokens",
    "outputTokens",
    "cacheCreationInputTokens",
    "cacheReadInputTokens",
    "reasoningTokens",
] as const satisfies readonly (keyof TokenUsageRollup)[];

/** One token-usage field name. */
export type TokenUsageField = (typeof TOKEN_USAGE_FIELDS)[number];

type _AssertFieldsComplete = Exclude<keyof TokenUsageRollup, TokenUsageField> extends never ? true : never;
const _assertFieldsComplete: _AssertFieldsComplete = true;
