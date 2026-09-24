/**
 * The reasoning depth of a call.
 *
 * The effort resolves in order: `ChatRequest.reasoning` (set only through
 * `RunAgentOptions.reasoning`), the provider configuration's `reasoning`, then
 * {@link DEFAULT_REASONING}. Anthropic discards its message cache when the
 * top-level effort changes between calls.
 *
 * Do not set `providerOptions.anthropic.effort` directly. It bypasses the
 * per-model table, and a model that rejects the raw name answers 400.
 */

import type { ReasoningPolicy } from "./types.js";

/**
 * The last source of the effort: the deepest rung of the neutral ladder.
 *
 * Each agent of the harness drives tools over many iterations. A shallow turn
 * there wastes more calls than a deeper turn costs in tokens. The Anthropic
 * package sends `xhigh` to a model that accepts it, and `max` to a model that
 * does not. The OpenAI-compatible package sends the name as it is.
 *
 * A host that wants a cheaper role sets a lower name on that role's provider
 * configuration. With no reasoning support, a host sets `"provider-default"`.
 */
export const DEFAULT_REASONING: ReasoningPolicy = "xhigh";
