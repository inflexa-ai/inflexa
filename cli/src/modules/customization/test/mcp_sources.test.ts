import { describe, expect, test } from "bun:test";

import { findMcpServers, knownMcpConfigs, planInstall, type RegistryServer } from "../mcp_sources.ts";

describe("findMcpServers", () => {
    const sources = knownMcpConfigs("/home/u", "linux");

    test("reads each harness form: a command, a URL, a Windsurf serverUrl, a VS Code `servers` map, and a Claude Code project", () => {
        const files: Record<string, Record<string, unknown>> = {
            "/home/u/.claude.json": {
                mcpServers: { lims: { command: "lims-mcp", args: ["--ro"], env: { TOKEN: "t" } } },
                projects: {
                    "/work/lab": { mcpServers: { notes: { type: "http", url: "https://notes.example/mcp", headers: { Authorization: "Bearer x" } } } },
                },
            },
            "/home/u/.codeium/windsurf/mcp_config.json": { mcpServers: { wiki: { serverUrl: "https://wiki.example/mcp" } } },
            "/home/u/.config/Code/User/mcp.json": { servers: { git: { command: "git-mcp" } } },
            "/home/u/.cursor/mcp.json": { mcpServers: { broken: { args: ["no command"] } } },
        };

        const found = findMcpServers(sources, (path) => files[path]);

        expect(found.map((server) => [server.source, server.name, server.project ?? null, server.entry.type])).toEqual([
            ["Claude Code", "lims", null, "stdio"],
            ["Claude Code", "notes", "/work/lab", "http"],
            ["Windsurf", "wiki", null, "http"],
            ["VS Code", "git", null, "stdio"],
        ]);
    });
});

describe("planInstall", () => {
    const remote: RegistryServer = {
        name: "ai.example/notes",
        description: "Notes.",
        version: "2.0.0",
        remotes: [
            {
                type: "streamable-http",
                url: "https://notes.example/mcp",
                headers: [{ name: "Authorization", value: "Bearer {api_key}", isSecret: true, isRequired: true }],
            },
        ],
    };

    test("a secret header that is a template keeps the template and references the credential in place of the variable", () => {
        const plan = planInstall(remote, 0, { Authorization: "k-1" }, (key) => `notes-${key.toLowerCase()}`)._unsafeUnwrap();

        expect(plan.entry).toEqual({ type: "http", url: "https://notes.example/mcp", headers: { Authorization: "Bearer ${cred:notes-authorization}" } });
        expect(plan.secrets).toEqual([{ credential: "notes-authorization", value: "k-1" }]);
    });

    test("an option that the entry does not have is refused", () => {
        expect(planInstall(remote, 3, {}, (key) => key)._unsafeUnwrapErr()).toEqual({ type: "unknown_install", id: 3 });
    });
});
