/**
 * A stdio MCP server for the tests of the MCP client. It speaks the handshake protocol: `initialize`, `tools/list`,
 * and `tools/call`. `SERVER_TAG` from the environment names the process, thus a test can tell two processes apart.
 */

import { createInterface } from "node:readline";

import { z } from "zod";

import { safeParseJsonAs } from "../../lib/parse-json.js";

const RequestSchema = z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string(),
    params: z.record(z.string(), z.json()).optional(),
});

const tag = process.env.SERVER_TAG ?? "untagged";

const tools = [
    { name: "echo.upper", description: "Upper-case a text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
    { name: "whoami", description: "The tag of this server process.", inputSchema: { type: "object", properties: {} } },
    { name: "picture", description: "A text and an image.", inputSchema: { type: "object", properties: {} } },
    {
        name: "either",
        description: "Takes one of two fields.",
        inputSchema: {
            type: "object",
            properties: { family: { type: "string" }, capability: { type: "string" } },
            oneOf: [{ required: ["family"] }, { required: ["capability"] }],
            additionalProperties: false,
        },
    },
];

function reply(id: string | number, result: unknown): void {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function callTool(params: Record<string, unknown> | undefined): unknown {
    const ArgsSchema = z.object({ name: z.string(), arguments: z.record(z.string(), z.json()).optional() });
    const { name, arguments: args } = ArgsSchema.parse(params);
    switch (name) {
        case "echo.upper":
            return { content: [{ type: "text", text: z.string().parse(args?.text).toUpperCase() }] };
        case "fail":
            return { isError: true, content: [{ type: "text", text: "boom" }] };
        case "whoami":
            return { content: [{ type: "text", text: tag }], structuredContent: { tag } };
        case "picture":
            return {
                content: [
                    { type: "text", text: "a chart" },
                    { type: "image", data: "aGk=", mimeType: "image/png" },
                ],
            };
        default:
            return { isError: true, content: [{ type: "text", text: `no tool ${name}` }] };
    }
}

createInterface({ input: process.stdin }).on("line", (line) => {
    const message = safeParseJsonAs(line, RequestSchema);
    if (!message.success || message.data.id === undefined) return;
    const { id, method, params } = message.data;
    switch (method) {
        case "initialize":
            reply(id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
            return;
        case "tools/list":
            reply(id, { tools });
            return;
        case "tools/call":
            reply(id, callTool(params));
            return;
        case "ping":
            reply(id, {});
            return;
        default:
            process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `no method ${method}` } })}\n`);
    }
});
