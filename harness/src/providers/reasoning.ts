/**
 * The reasoning depth of a run.
 *
 * The harness states the depth one time, on `ChatRequest.reasoning`, with the
 * neutral names of the AI SDK. It names no vendor key. Each provider package
 * holds the table of what its own models accept, and it maps the neutral name
 * onto the wire. The Anthropic package also selects adaptive thinking there.
 *
 * ## Why the harness names no vendor key
 *
 * The harness wrote `providerOptions.anthropic.effort` before. A value on that
 * key turns the per-model table of the Anthropic package off, thus the raw name
 * reached the wire. A model that accepts `high` but not `xhigh` answered 400.
 * The neutral field has no such hazard, because the package resolves the name
 * for the model that it is bound to.
 *
 * ## Where the policy belongs
 *
 * The policy rides on the run, not on the provider, for the same reason that the
 * cache policy does. A one-shot LLM call elsewhere in the harness has its own
 * depth needs, and it must not inherit the depth of an agent loop.
 */

import type { ReasoningPolicy } from "./types.js";

/**
 * The default policy: the deepest name of the neutral ladder.
 *
 * Each agent of the harness drives tools over many iterations. A shallow turn
 * there wastes more calls than a deeper turn costs in tokens. The Anthropic
 * package sends `xhigh` to a model that accepts it, and `max` to a model that
 * does not. The OpenAI-compatible package sends the name as it is.
 *
 * A host that wants a cheaper loop passes a lower name. A host on a model with
 * no reasoning support passes `"provider-default"`.
 */
export const DEFAULT_REASONING: ReasoningPolicy = "xhigh";
