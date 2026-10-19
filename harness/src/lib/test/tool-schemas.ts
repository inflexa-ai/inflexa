import { recordMember, maybeRecord } from "../shape.js";

/**
 * The JSON-Schema document an AI SDK tool definition emits for its input.
 *
 * `ToolSet` erases a tool's input to `any`, so the wrapper and the document
 * are read through the record guards instead of the SDK's member chain.
 */
export function emittedInputSchema(inputSchema: unknown): Record<string, unknown> {
    const emitted = recordMember(maybeRecord(inputSchema), "jsonSchema");
    if (emitted === undefined) throw new Error("expected a json-schema definition");
    return emitted;
}
