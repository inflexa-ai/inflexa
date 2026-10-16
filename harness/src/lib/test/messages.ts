import type { ModelMessage, ToolResultPart } from "ai";

/**
 * The tool-result parts of a model message: empty unless the message is the
 * tool role. The `ToolContent` array mixes results with approval responses,
 * and the loop's reads want the results alone.
 */
export function toolResultParts(message: ModelMessage): ToolResultPart[] {
    if (message.role !== "tool") return [];
    return message.content.flatMap((part) => (part.type === "tool-result" ? [part] : []));
}

/**
 * The `value` a tool output carries (`text`, `json`, `error-text`,
 * `error-json`, `content`); `undefined` for `execution-denied`, which is the
 * one member without a value.
 */
export function outputValue(output: ToolResultPart["output"]): unknown {
    return "value" in output ? output.value : undefined;
}
