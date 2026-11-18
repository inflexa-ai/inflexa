/**
 * The MCP client of the harness. Each call runs in the harness process on the host, never in the sandbox. The harness
 * connects to a server at its first use, keeps the connection for the process, and connects again when the config of
 * the server changes.
 */

import { Client, StreamableHTTPClientTransport, UnauthorizedError, type Tool as McpTool } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { err, ok } from "neverthrow";
import { z } from "zod";

import type { McpAgentTools, McpServerFailure, McpToolSource } from "../catalog/equip.js";
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

function transportOf(config: McpServerConfig, onStderr: (text: string) => void): StdioClientTransport | StreamableHTTPClientTransport {
    const { transport } = config;
    if (transport.kind === "stdio") {
        const stdio = new StdioClientTransport({
            command: transport.command,
            args: [...transport.args],
            // The default environment of the SDK (HOME, PATH, and a few more) and the env of the config. Nothing else of
            // the harness process reaches the server.
            env: { ...getDefaultEnvironment(), ...transport.env },
            stderr: "pipe",
        });
        // A piped stream that nobody reads fills its buffer and stops the server, thus each chunk is read.
        stdio.stderr?.on("data", (chunk: Buffer | string) => onStderr(chunk.toString()));
        return stdio;
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
    /** The last start failure of each server, by name. A later start of the server clears it. */
    readonly failures: () => ReadonlyMap<string, McpServerFailure>;
};

/** The most characters of the error output of a local server that a failure keeps: its last lines. */
const STDERR_TAIL_CHARS = 2000;

/** The reason of a failed start: the error, and the last error output of a local server when it wrote some. */
function failureReasonOf(failure: unknown, stderrTail: string | undefined): string {
    const message = errorMessageOf(failure) ?? "the server did not start";
    const tail = stderrTail?.trim();
    return tail === undefined || tail.length === 0 ? message : `${message}. The last error output of the server: ${tail}`;
}

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
    const failures = new Map<string, McpServerFailure>();
    // The last error output of each local server, for the reason of a failed start.
    const stderrTails = new Map<string, string>();
    const keepStderr = (server: string, text: string): void => {
        stderrTails.set(server, ((stderrTails.get(server) ?? "") + text).slice(-STDERR_TAIL_CHARS));
    };

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
            stderrTails.delete(config.name);
            await made.connect(
                transportOf(config, (text) => keepStderr(config.name, text)),
                { timeout: CONNECT_TIMEOUT_MS },
            );
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
        // The Anthropic API refuses `oneOf`, `anyOf` and `allOf` at the top level of a tool schema, and one refused
        // tool fails each model request of the agent. The MCP server still checks the arguments of each call.
        const { oneOf: _oneOf, anyOf: _anyOf, allOf: _allOf, ...accepted } = tool.inputSchema;
        const jsonSchema: Record<string, unknown> = { ...accepted, type: "object" };
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
        const unavailable: McpServerFailure[] = [];
        for (const server of servers) {
            const config = resolved.mcpServers.get(server);
            if (config === undefined) continue;
            latest.set(server, config);
            let listed: readonly McpTool[];
            try {
                const client = await clientOf(config);
                listed = (await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS })).tools;
            } catch (failure) {
                // An absent server is a normal state: the agent runs with its other tools, and it learns the reason.
                const recorded: McpServerFailure = { server, at: new Date(), reason: failureReasonOf(failure, stderrTails.get(server)) };
                failures.set(server, recorded);
                unavailable.push(recorded);
                logger.warn("an MCP server did not answer; its tools are absent", { server, reason: recorded.reason, ...logger.errorFields(failure) });
                await closeConnection(server);
                continue;
            }
            failures.delete(server);
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
        return { direct, script, unavailable };
    };

    return {
        toolsFor,
        failures: () => new Map(failures),
        close: async () => {
            await Promise.all([...connections.keys()].map((name) => closeConnection(name)));
        },
    };
}
