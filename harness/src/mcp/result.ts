import type { CallToolResult } from "@modelcontextprotocol/client";

/** The output of one MCP call as an agent reads it. */
export type McpToolOutput = {
    readonly text: string;
    readonly structuredContent?: unknown;
};

/** One line for a content block that holds no text: its type, and its URI or its media type. */
function placeholderOf(block: CallToolResult["content"][number]): string {
    switch (block.type) {
        case "image":
            return `[image: ${block.mimeType}]`;
        case "audio":
            return `[audio: ${block.mimeType}]`;
        case "resource":
            return `[resource: ${block.resource.uri}]`;
        case "resource_link":
            return `[resource link: ${block.uri}]`;
        default:
            return `[${block.type}]`;
    }
}

/**
 * The text of a result: each text block, and one line for each block of another type. The text blocks are the
 * answer, thus they keep their order. `structuredContent` rides as JSON beside the text.
 */
export function mcpOutputOf(result: CallToolResult): McpToolOutput {
    const text = result.content.map((block) => (block.type === "text" ? block.text : placeholderOf(block))).join("\n\n");
    return result.structuredContent === undefined ? { text } : { text, structuredContent: result.structuredContent };
}
