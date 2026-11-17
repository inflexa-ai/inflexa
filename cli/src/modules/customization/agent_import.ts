import type { AgentRole, CustomAgent, ResolvedAgent } from "@inflexa-ai/harness";
import { err, ok, type Result } from "neverthrow";

import { mcpServerNamesOf, parseAgentFrontmatter, toolNamesOf, type AgentFileGap } from "./agent_files.ts";

/**
 * The tools of other harnesses that each executor already has through its role: the file tools, the shell, the search
 * of files, and the task list. The import drops them, because they map to the workspace tools of the role.
 */
const ROLE_TOOL_NAMES: ReadonlySet<string> = new Set([
    // Claude Code, the Claude Agent SDK, and Cursor.
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "Bash",
    "BashOutput",
    "KillShell",
    "Grep",
    "Glob",
    "LS",
    "TodoWrite",
    "NotebookRead",
    // GitHub Copilot and VS Code aliases.
    "read",
    "edit",
    "execute",
    "search",
    "todo",
    "runCommands",
    "codebase",
    "editFiles",
    // OpenCode and Gemini CLI.
    "write",
    "bash",
    "glob",
    "grep",
    "list",
    "read_file",
    "write_file",
    "replace",
    "run_shell_command",
    "list_directory",
    "search_file_content",
]);

/**
 * The MCP server that a foreign tool name references, or `undefined` for a name of another kind. Each form that the
 * agent formats of other harnesses use reads: `mcp__<server>__<tool>` and `mcp__<server>__*` (Claude Code),
 * `<server>/<tool>` (Copilot), `mcp_<server>_*` (Gemini CLI), and `<server>_<tool>` for a server that the config
 * defines (OpenCode).
 */
export function mcpServerOfToolName(name: string, knownServers: ReadonlySet<string>): string | undefined {
    if (name.startsWith("mcp__")) {
        const rest = name.slice("mcp__".length);
        const end = rest.indexOf("__");
        return end === -1 ? rest : rest.slice(0, end);
    }
    const slash = name.indexOf("/");
    if (slash > 0) return name.slice(0, slash);
    if (name.startsWith("mcp_")) {
        const rest = name.slice("mcp_".length);
        const end = rest.lastIndexOf("_");
        return end === -1 ? rest : rest.slice(0, end);
    }
    for (const server of knownServers) if (name.startsWith(`${server}_`)) return server;
    return undefined;
}

/** A foreign agent file converted to the Inflexa format, with the gaps that the user must fix. */
export type ImportedAgent = {
    readonly id: string;
    readonly definition: CustomAgent;
    /** Tool names that map to nothing. The file keeps them under `tools`, thus the agent stays a draft until the user removes them. */
    readonly unmappedTools: readonly string[];
};

/** Why a foreign agent file cannot convert at all. */
export type ImportError = { readonly type: "unreadable"; readonly gap: AgentFileGap } | { readonly type: "no_id" };

/** A file name or a `name` as an agent id: lowercase letters, digits, and hyphens. */
export function agentIdOf(name: string): string {
    let id = "";
    for (const char of name.toLowerCase()) {
        const keep = (char >= "a" && char <= "z") || (char >= "0" && char <= "9");
        id += keep ? char : "-";
    }
    return id
        .split("-")
        .filter((part) => part.length > 0)
        .join("-");
}

/**
 * Convert a foreign agent file. The import keeps the name, the description, and the prompt. It drops `model` and each
 * other field that Inflexa does not use, it drops each tool that the role already gives, and it maps each MCP tool
 * reference to a server name. A tool that maps to nothing stays under `tools`. A server that the file defines inline
 * becomes a reference by its name, which stays a gap until the user defines the server in the config.
 */
export function convertForeignAgent(text: string, knownServers: ReadonlySet<string>, role: AgentRole = "executor"): Result<ImportedAgent, ImportError> {
    const parsed = parseAgentFrontmatter(text);
    if (parsed.isErr()) return err({ type: "unreadable", gap: parsed.error });
    const { frontmatter, body } = parsed.value;
    const id = agentIdOf(frontmatter.name);
    if (id.length === 0) return err({ type: "no_id" });

    const declared = mcpServerNamesOf(frontmatter.mcpServers);
    const servers: string[] = [...declared.named, ...declared.inline];
    const unmappedTools: string[] = [];
    for (const tool of toolNamesOf(frontmatter.tools)) {
        if (ROLE_TOOL_NAMES.has(tool)) continue;
        const server = mcpServerOfToolName(tool, knownServers);
        if (server !== undefined) {
            if (!servers.includes(server)) servers.push(server);
            continue;
        }
        unmappedTools.push(tool);
    }
    return ok({
        id,
        unmappedTools,
        definition: {
            id,
            name: id,
            role,
            description: frontmatter.description,
            prompt: body,
            connectors: frontmatter.connectors ?? [],
            mcp: servers,
            skills: frontmatter.skills ?? [],
        },
    });
}

/** Why a clone cannot run. */
export type CloneError = { readonly type: "unknown_agent"; readonly id: string };

/**
 * The definition of a clone of an agent: its role, its prompt body, its description, and its attachments as the user
 * has them now. The clone has no link to its source, thus a release that changes a built-in agent leaves the clone as
 * it is.
 */
export function cloneDefinition(source: ResolvedAgent | undefined, sourceId: string, newId: string): Result<CustomAgent, CloneError> {
    if (source === undefined) return err({ type: "unknown_agent", id: sourceId });
    return ok({
        id: newId,
        name: newId,
        role: source.role,
        description: source.description,
        prompt: source.prompt,
        connectors: source.attachments.connectors,
        mcp: source.attachments.mcp,
        skills: source.attachments.skills,
    });
}
