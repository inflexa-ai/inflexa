/**
 * The MCP client of the harness. Each call runs in the harness process on the host, never in the sandbox. The harness
 * connects to a server at its first use, keeps the connection for the process, and connects again when the config of
 * the server changes.
 */

import { Client, StreamableHTTPClientTransport, UnauthorizedError, type Tool as McpTool } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { err, ok } from "neverthrow";
import { z } from "zod";

import type { McpAgentTools, McpToolSource } from "../catalog/equip.js";
import type { ResolvedCatalog } from "../catalog/resolve.js";
import type { McpServerConfig } from "../catalog/types.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { errorMessageOf } from "../lib/thrown.js";
import type { Tool, ToolError } from "../tools/define-tool.js";
import { mcpToolNames } from "./names.js";
import { mcpOutputOf, type McpToolOutput } from "./result.js";

/** The time that a connect or a listing of tools can take before the server counts as absent. */
const CONNECT_TIMEOUT_MS = 30_000;

/** The shape of the config that decides a new connection. The OAuth provider is an object of the host, thus it is not part of it. */
function fingerprintOf(config: McpServerConfig): string {
    const { transport } = config;
    return transport.kind === "stdio"
        ? JSON.stringify(["stdio", transport.command, transport.args, transport.env])
        : JSON.stringify(["http", transport.url, transport.headers]);
}

function transportOf(config: McpServerConfig): StdioClientTransport | StreamableHTTPClientTransport {
    const { transport } = config;
    if (transport.kind === "stdio") {
        return new StdioClientTransport({
            command: transport.command,
            args: [...transport.args],
            // The default environment of the SDK (HOME, PATH, and a few more) and the env of the config. Nothing else of
            // the harness process reaches the server.
            env: { ...getDefaultEnvironment(), ...transport.env },
            stderr: "ignore",
        });
    }
    return new StreamableHTTPClientTransport(new URL(transport.url), {
        requestInit: { headers: { ...transport.headers } },
        authProvider: transport.auth,
    });
}

/**
 * The tool error of a failed MCP call. A sign-in that the server refuses, and that the stored refresh token cannot
 * renew, needs the user: the error says so and names the server. Any other failure is a server that did not answer.
 */
export function mcpCallErrorOf(server: string, failure: unknown): ToolError {
    if (failure instanceof UnauthorizedError) {
        return { error: `The MCP server ${server} refused the stored sign-in. The user must sign in to it again.`, retryable: false };
    }
    return { error: `The MCP server ${server} did not answer: ${errorMessageOf(failure) ?? "unknown error"}`, retryable: true, cause: failure };
}

/** The input of an MCP tool: a JSON object. The server validates it against its own schema. */
const McpInputSchema = z.record(z.string(), z.json());

type Connection = {
    readonly fingerprint: string;
    readonly client: Promise<Client>;
};

export type McpConnections = McpToolSource & {
    /** Close each connection. The assembly calls it at shutdown. */
    readonly close: () => Promise<void>;
};

export type McpConnectionsDeps = {
    readonly logger?: Logger;
    /** The name and the version that the client gives each server. */
    readonly clientInfo?: { readonly name: string; readonly version: string };
};

export function createMcpConnections(deps: McpConnectionsDeps = {}): McpConnections {
    const logger = (deps.logger ?? createNoopLogger()).named("mcp");
    const clientInfo = deps.clientInfo ?? { name: "inflexa", version: "1" };
    const connections = new Map<string, Connection>();
    // The config of each server as the catalog gave it last. A tool of an earlier turn reaches the server through it,
    // thus a changed config replaces the process once, and an old tool does not bring the old process back.
    const latest = new Map<string, McpServerConfig>();

    const closeConnection = async (name: string): Promise<void> => {
        const connection = connections.get(name);
        connections.delete(name);
        if (connection === undefined) return;
        try {
            await (await connection.client).close();
        } catch (failure) {
            logger.warn("an MCP connection did not close", { server: name, ...logger.errorFields(failure) });
        }
    };

    const clientOf = async (config: McpServerConfig): Promise<Client> => {
        const fingerprint = fingerprintOf(config);
        const known = connections.get(config.name);
        if (known !== undefined && known.fingerprint !== fingerprint) await closeConnection(config.name);
        const current = connections.get(config.name);
        if (current !== undefined) return current.client;
        const client = (async () => {
            const made = new Client(clientInfo);
            await made.connect(transportOf(config), { timeout: CONNECT_TIMEOUT_MS });
            return made;
        })();
        connections.set(config.name, { fingerprint, client });
        // A failed connect leaves no connection behind, thus the next use connects again.
        client.catch(() => {
            if (connections.get(config.name)?.client === client) connections.delete(config.name);
        });
        return client;
    };

    const toolOf = (config: McpServerConfig, tool: McpTool, name: string): Tool<Record<string, unknown>, McpToolOutput> => {
        const jsonSchema: Record<string, unknown> = { ...tool.inputSchema, type: "object" };
        const built: Tool<Record<string, unknown>, McpToolOutput> = {
            id: name,
            description: tool.description ?? tool.title ?? `The tool ${tool.name} of the MCP server ${config.name}.`,
            inputSchema: McpInputSchema,
            jsonSchema,
            execute: async (input, ctx) => {
                try {
                    const client = await clientOf(latest.get(config.name) ?? config);
                    const result = await client.callTool({ name: tool.name, arguments: input }, { signal: ctx.signal });
                    const output = mcpOutputOf(result);
                    if (result.isError === true) return err({ error: output.text || `The MCP tool ${tool.name} failed.`, retryable: false });
                    return ok(output);
                } catch (failure) {
                    const error = mcpCallErrorOf(config.name, failure);
                    // A dead connection connects again at the next call. A refused sign-in keeps its connection.
                    if (error.retryable) await closeConnection(config.name);
                    return err(error);
                }
            },
        };
        // The approval is a setting of the server. The annotations of a server are hints, and the harness does not trust them.
        if (config.approval === "always") {
            built.approval = (input) => ({
                title: `Run ${tool.name} on the MCP server ${config.name}`,
                command: `${config.name}: ${tool.name} ${JSON.stringify(input)}`,
                grantKey: `mcp:${config.name}:${tool.name}`,
            });
        }
        return built;
    };

    const toolsFor = async (servers: readonly string[], resolved: ResolvedCatalog): Promise<McpAgentTools> => {
        const direct: Tool[] = [];
        const script: Tool[] = [];
        for (const server of servers) {
            const config = resolved.mcpServers.get(server);
            if (config === undefined) continue;
            latest.set(server, config);
            let listed: readonly McpTool[];
            try {
                const client = await clientOf(config);
                listed = (await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS })).tools;
            } catch (failure) {
                // An absent server is a normal state: the agent runs with its other tools.
                logger.warn("an MCP server did not answer; its tools are absent", { server, ...logger.errorFields(failure) });
                await closeConnection(server);
                continue;
            }
            const names = mcpToolNames(
                server,
                listed.map((tool) => tool.name),
            );
            for (const tool of listed) {
                const built = toolOf(config, tool, names.get(tool.name) ?? tool.name);
                direct.push(built);
                if (config.scriptable) script.push(built);
            }
        }
        return { direct, script };
    };

    return {
        toolsFor,
        close: async () => {
            await Promise.all([...connections.keys()].map((name) => closeConnection(name)));
        },
    };
}
