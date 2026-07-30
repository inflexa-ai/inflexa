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
