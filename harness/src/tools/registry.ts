/**
 * Tool registry — a name→`Tool` map.
 *
 * `definitions()` emits AI SDK-compatible tool definitions; `get(name)`
 * resolves a tool by name for the loop's dispatch boundary (change 3).
 */

import { jsonSchema, tool as aiTool, type ToolSet } from "ai";

import type { Tool } from "./define-tool.js";

export interface Registry {
    /** The AI SDK tool definitions to send with a chat request. */
    definitions(): ToolSet;
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
            Object.fromEntries(
                tools.map((t) => [
                    t.id,
                    aiTool({
                        description: t.description,
                        inputSchema: jsonSchema(t.jsonSchema),
                    }),
                ]),
            ),
        get: (name) => byName.get(name),
    };
}
