/**
 * The reasoning depth of a call.
 *
 * The harness states the depth with the neutral names of the AI SDK, and it
 * names no vendor key. Each provider package holds the table of what its own
 * models accept, and it maps the neutral name onto the wire. The Anthropic
 * package also selects adaptive thinking there.
 *
 * ## The order of the effort
 *
 * The provider selects the effort of each call from the first source that gives
 * a value:
 *
 * 1. `ChatRequest.reasoning`, if the request sets it. `runAgent` sets it only
 *    when its caller gives `RunAgentOptions.reasoning`.
 * 2. The `reasoning` of the provider configuration.
 * 3. {@link DEFAULT_REASONING}.
 *
 * A host sets the effort of a role on the provider of that role, beside the
 * model of that role. Thus a direct `provider.chat` call without a value runs at
 * the configured effort, and one provider sends the same effort on each call of
 * a conversation. Anthropic discards its message cache when the top-level effort
 * changes.
 *
 * ## Why the harness names no vendor key
 *
 * A value on `providerOptions.anthropic.effort` turns the per-model table of the
 * Anthropic package off, thus the raw name reaches the wire. A model that
 * accepts `high` but not `xhigh` then answers 400. The neutral field has no such
 * hazard, because the package resolves the name for the model that it is bound
 * to.
 */

import type { ReasoningPolicy } from "./types.js";

/**
 * The last source of the effort: the deepest name of the neutral ladder. A call
 * runs at this value when neither its request nor its provider configuration
 * sets one.
 *
 * Each agent of the harness drives tools over many iterations. A shallow turn
 * there wastes more calls than a deeper turn costs in tokens. The Anthropic
 * package sends `xhigh` to a model that accepts it, and `max` to a model that
 * does not. The OpenAI-compatible package sends the name as it is.
 *
 * A host that wants a cheaper role sets a lower name on the provider
 * configuration of that role. A host on a model with no reasoning support sets
 * `"provider-default"`.
 */
export const DEFAULT_REASONING: ReasoningPolicy = "xhigh";
