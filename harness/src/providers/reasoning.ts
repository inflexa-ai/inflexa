/**
 * Reasoning policy → provider wire options.
 *
 * This is the **only** place in the harness that names a vendor for reasoning
 * depth. Everything upstream — `ReasoningPolicy` and `RunAgentOptions` — speaks
 * the neutral harness concept. This module translates it one time, at the
 * provider seam, thus the loop never learns which vendor it talks to. It is the
 * sibling of `prompt-cache.ts`, and it obeys the same rules.
 *
 * ## Why the emitted options are safe on every provider
 *
 * `providerOptions` of the AI SDK is a namespaced bag. Each provider reads only
 * `providerOptions[<its own name>]`, and it ignores each other key. Thus the
 * `anthropic` namespace is inert on an OpenAI model, and the `openai` namespace
 * is inert on an Anthropic model. Neither one is an error.
 *
 * ## What each namespace does
 *
 * The Anthropic namespace carries two keys, because the vendor splits the
 * concept in two:
 *
 *  - `thinking: { type: "adaptive" }` says that the model reasons, and it lets
 *    the model choose the depth for each turn. A fixed `budgetTokens` is removed
 *    on the current models, and it returns a 400 there.
 *  - `effort` says how deep the model reasons and how much it spends in total.
 *    The vendor default is `high`.
 *
 * The OpenAI namespace carries one key, `reasoningEffort`, which takes the same
 * five values. An OpenAI-compatible endpoint reads the same key, but from a
 * namespace that carries the *name of the connection* rather than `openai`. The
 * provider seam mirrors the value into that namespace, because only the seam
 * knows the name (`providers/ai-sdk.ts`).
 *
 * ## Where the policy belongs
 *
 * The policy rides on the run, not on the provider, for the same reason that the
 * cache policy does. A one-shot LLM call elsewhere in the harness has its own
 * depth needs, and it must not inherit the depth of an agent loop.
 */

import type { ProviderOptions, ReasoningPolicy } from "./types.js";

/**
 * The default policy: adaptive thinking at the `xhigh` effort.
 *
 * `xhigh` sits between `high` and `max`. It is the vendor recommendation for
 * coding and agentic work, and each agent of the harness drives tools over many
 * iterations. `max` costs more than the remaining quality is worth for a routine
 * turn, thus it is not the default. A host that wants a cheaper loop passes a
 * lower effort, and a host on a model with no reasoning support passes `"off"`.
 */
export const DEFAULT_REASONING: ReasoningPolicy = { effort: "xhigh" };

/**
 * Translate a neutral reasoning policy into provider wire options.
 *
 * Returns `undefined` for `"off"`, thus the caller can leave `providerOptions`
 * unset rather than send an empty bag.
 */
export function reasoningProviderOptions(policy: ReasoningPolicy): ProviderOptions | undefined {
    if (policy === "off") return undefined;
    return {
        anthropic: { effort: policy.effort, thinking: { type: "adaptive" } },
        openai: { reasoningEffort: policy.effort },
    };
}

/**
 * Merge two option bags one namespace at a time.
 *
 * A plain spread of the two bags drops a whole namespace when both sides carry
 * it, and the cache policy and the reasoning policy both write `anthropic`. The
 * right-hand bag wins for a key that both sides set.
 */
export function mergeProviderOptions(left: ProviderOptions | undefined, right: ProviderOptions | undefined): ProviderOptions | undefined {
    if (left === undefined) return right;
    if (right === undefined) return left;
    const merged: ProviderOptions = { ...left };
    for (const [namespace, options] of Object.entries(right)) {
        merged[namespace] = { ...merged[namespace], ...options };
    }
    return merged;
}
