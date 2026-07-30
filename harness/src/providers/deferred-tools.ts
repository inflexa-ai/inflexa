import { anthropic } from "@ai-sdk/anthropic";
import type { ToolSet } from "ai";

const TOOL_SEARCH_KEY = "__harness_anthropic_tool_search";

/**
 * Build the Anthropic realization of the harness's neutral deferred-tool hint.
 *
 * The full catalog still goes over the wire. Anthropic excludes marked tools
 * from the initial model context, then its server-side BM25 tool discovers and
 * expands matching definitions as provider-executed tool-reference blocks.
 */
export function prepareAnthropicDeferredTools(tools: ToolSet, deferredToolNames: readonly string[]): ToolSet {
    const deferred = new Set(deferredToolNames.filter((name) => tools[name] !== undefined));
    if (deferred.size === 0) return tools;
    if (tools[TOOL_SEARCH_KEY] !== undefined) {
        throw new Error(`Tool id "${TOOL_SEARCH_KEY}" is reserved for Anthropic deferred-tool search`);
    }

    const prepared: ToolSet = {};
    for (const [name, definition] of Object.entries(tools)) {
        if (!deferred.has(name)) {
            prepared[name] = definition;
            continue;
        }
        const providerOptions = definition.providerOptions;
        prepared[name] = {
            ...definition,
            providerOptions: {
                ...providerOptions,
                anthropic: {
                    ...(providerOptions?.anthropic ?? {}),
                    deferLoading: true,
                },
            },
        };
    }
    prepared[TOOL_SEARCH_KEY] = anthropic.tools.toolSearchBm25_20251119();
    return prepared;
}
