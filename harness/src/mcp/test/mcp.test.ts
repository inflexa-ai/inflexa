import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";

import { createInMemoryCatalog } from "../../catalog/memory.js";
import { resolveCatalog } from "../../catalog/resolve.js";
import type { McpServerConfig } from "../../catalog/types.js";
import type { Tool } from "../../tools/define-tool.js";
import { makeToolContext } from "../../tools/__fixtures__/tool-context.js";
import { UnauthorizedError } from "@modelcontextprotocol/client";

import { createMcpConnections, mcpCallErrorOf, type McpConnections } from "../connections.js";
import { MAX_TOOL_NAME_LENGTH, mcpToolNames } from "../names.js";
import { mcpOutputOf } from "../result.js";

const FIXTURE = join(import.meta.dir, "..", "__fixtures__", "stdio-server.ts");

const stdio = (name: string, tag: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
    name,
    transport: { kind: "stdio", command: process.execPath, args: [FIXTURE], env: { SERVER_TAG: tag } },
    approval: "never",
    scriptable: false,
    ...overrides,
});

const context = makeToolContext().ctx;

function toolNamed(tools: readonly Tool[], id: string): Tool {
    const tool = tools.find((candidate) => candidate.id === id);
    if (tool === undefined) throw new Error(`no tool ${id} in ${tools.map((candidate) => candidate.id).join(", ")}`);
    return tool;
}

let connections: McpConnections | undefined;
afterEach(async () => {
    await connections?.close();
    connections = undefined;
});

async function toolsOf(servers: readonly McpServerConfig[], attach: readonly string[]) {
    connections = createMcpConnections();
    const resolved = await resolveCatalog(createInMemoryCatalog({ mcpServers: servers }));
    return connections.toolsFor(attach, resolved);
}

describe("mcpToolNames", () => {
    it("prefixes the server and replaces each character that a provider refuses", () => {
        expect(mcpToolNames("github", ["repos.search"]).get("repos.search")).toBe("mcp__github__repos_search");
    });

    it("cuts a long name to the limit and ends it with a hash", () => {
        const long = "x".repeat(90);
        const name = mcpToolNames("lims", [long]).get(long) ?? "";
        expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
        expect(name.startsWith("mcp__lims__")).toBe(true);
    });

    it("keeps two tools that give one name apart", () => {
        const names = mcpToolNames("lims", ["a.b", "a_b"]);
        expect(names.get("a.b")).not.toBe(names.get("a_b"));
    });
});

describe("mcpOutputOf", () => {
    it("joins the text blocks and names each other block in one line", () => {
        const output = mcpOutputOf({
            content: [
                { type: "text", text: "a chart" },
                { type: "image", data: "aGk=", mimeType: "image/png" },
            ],
        });
        expect(output.text).toBe("a chart\n\n[image: image/png]");
    });

    it("keeps structured content beside the text", () => {
        expect(mcpOutputOf({ content: [{ type: "text", text: "x" }], structuredContent: { a: 1 } })).toEqual({ text: "x", structuredContent: { a: 1 } });
    });
});

describe("createMcpConnections", () => {
    it("gives the tools of an attached stdio server, and calls them in the harness process", async () => {
        const tools = await toolsOf([stdio("lims", "one")], ["lims"]);
        expect(tools.direct.map((tool) => tool.id).sort()).toEqual(["mcp__lims__echo_upper", "mcp__lims__fail", "mcp__lims__picture", "mcp__lims__whoami"]);
        expect(tools.script).toEqual([]);
        const result = await toolNamed(tools.direct, "mcp__lims__echo_upper").execute({ text: "hi" }, context);
        expect(result._unsafeUnwrap()).toEqual({ text: "HI" });
    });

    it("turns an error result into a tool error", async () => {
        const tools = await toolsOf([stdio("lims", "one")], ["lims"]);
        const result = await toolNamed(tools.direct, "mcp__lims__fail").execute({}, context);
        expect(result._unsafeUnwrapErr().error).toBe("boom");
    });

    it("asks approval for each call of a server that needs it", async () => {
        const tools = await toolsOf([stdio("lims", "one", { approval: "always" })], ["lims"]);
        const whoami = toolNamed(tools.direct, "mcp__lims__whoami");
        const request = await whoami.approval?.({}, { invocationId: "call-1", session: context.session });
        expect(request?.grantKey).toBe("mcp:lims:whoami");
        const free = await toolsOf([stdio("lims", "one")], ["lims"]);
        expect("approval" in toolNamed(free.direct, "mcp__lims__whoami")).toBe(false);
    });

    it("gives the tools of a scriptable server to run_script too", async () => {
        const tools = await toolsOf([stdio("lims", "one", { scriptable: true })], ["lims"]);
        expect(tools.script.map((tool) => tool.id)).toContain("mcp__lims__whoami");
    });

    it("leaves out a server that does not start and keeps the other", async () => {
        const broken: McpServerConfig = { ...stdio("broken", "x"), transport: { kind: "stdio", command: "/no/such/command", args: [], env: {} } };
        const tools = await toolsOf([broken, stdio("lims", "one")], ["broken", "lims"]);
        expect(tools.direct.every((tool) => tool.id.startsWith("mcp__lims__"))).toBe(true);
        expect(tools.direct.length).toBe(4);
    });

    it("gives no tool of a server that the agent does not attach", async () => {
        const tools = await toolsOf([stdio("lims", "one"), stdio("other", "two")], ["lims"]);
        expect(tools.direct.some((tool) => tool.id.startsWith("mcp__other__"))).toBe(false);
    });

    it("starts a new process when the config of a server changes", async () => {
        connections = createMcpConnections();
        const first = await connections.toolsFor(["lims"], await resolveCatalog(createInMemoryCatalog({ mcpServers: [stdio("lims", "one")] })));
        const second = await connections.toolsFor(["lims"], await resolveCatalog(createInMemoryCatalog({ mcpServers: [stdio("lims", "two")] })));
        expect((await toolNamed(first.direct, "mcp__lims__whoami").execute({}, context))._unsafeUnwrap()).toEqual({
            text: "two",
            structuredContent: { tag: "two" },
        });
        expect((await toolNamed(second.direct, "mcp__lims__whoami").execute({}, context))._unsafeUnwrap()).toEqual({
            text: "two",
            structuredContent: { tag: "two" },
        });
    });
});

describe("mcpCallErrorOf", () => {
    it("asks the user for a new sign-in when the server refuses the stored one", () => {
        const error = mcpCallErrorOf("lims", new UnauthorizedError());
        expect(error.error).toContain("lims");
        expect(error.error).toContain("sign in");
        expect(error.retryable).toBe(false);
    });

    it("reports any other failure as a server that did not answer", () => {
        const error = mcpCallErrorOf("lims", new Error("connection reset"));
        expect(error.error).toBe("The MCP server lims did not answer: connection reset");
        expect(error.retryable).toBe(true);
    });
});
