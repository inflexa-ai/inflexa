/**
 * Tool registry — a name→`Tool` map.
 *
 * `definitions()` emits the Anthropic `Tool[]` sent on the wire; `get(name)`
 * resolves a tool by name for the loop's dispatch boundary (change 3).
 */

import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages";

import type { Tool } from "./define-tool.js";

export interface Registry {
    /** The Anthropic tool definitions to send with a chat request. */
    definitions(): AnthropicTool[];
    /** Resolve a tool by name for dispatch; `undefined` if unknown. */
    get(name: string): Tool | undefined;
}

export function createRegistry(tools: readonly Tool[]): Registry {
    const byName = new Map<string, Tool>();
    for (const tool of tools) {
        if (byName.has(tool.id)) {
            throw new Error(`createRegistry: duplicate tool id "${tool.id}"`);
        }
        byName.set(tool.id, tool);
    }

    return {
        definitions: () =>
            tools.map((t) => ({
                name: t.id,
                description: t.description,
                input_schema: t.jsonSchema as AnthropicTool["input_schema"],
            })),
        get: (name) => byName.get(name),
    };
}
