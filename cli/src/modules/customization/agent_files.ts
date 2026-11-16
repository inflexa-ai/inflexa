import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { CustomAgent } from "@inflexa-ai/harness";
import { err, ok, Result } from "neverthrow";
import { z } from "zod";

import { messageOf } from "../../lib/cause.ts";

/**
 * The frontmatter of a custom agent file. The field names are those of Claude Code subagents where a field exists,
 * plus `role` and `connectors`. `tools` is a field of a foreign file: in a file of the agents directory it is a gap,
 * because a user attaches connectors and MCP servers, never single tools. `model` is accepted and ignored, because the
 * role models of the config choose the model of each agent.
 */
const AgentFrontmatterSchema = z.looseObject({
    name: z.string().min(1),
    description: z.string().min(1),
    role: z.string().optional(),
    connectors: z.array(z.string()).optional(),
    mcpServers: z.array(z.union([z.string(), z.record(z.string(), z.looseObject({}))])).optional(),
    skills: z.array(z.string()).optional(),
    tools: z.union([z.array(z.string()), z.string()]).optional(),
});

/** Why a file of the agents directory is a draft. Each gap names what the user must fix. */
export type AgentFileGap =
    | { readonly type: "no_frontmatter" }
    | { readonly type: "invalid_yaml"; readonly detail: string }
    | { readonly type: "missing_fields"; readonly detail: string }
    | { readonly type: "name_mismatch"; readonly name: string }
    | { readonly type: "builtin_id" }
    | { readonly type: "duplicate_id" }
    | { readonly type: "role_not_allowed"; readonly role: string }
    | { readonly type: "unknown_connector"; readonly name: string }
    | { readonly type: "unknown_mcp_server"; readonly name: string }
    | { readonly type: "inline_mcp_server"; readonly name: string }
    | { readonly type: "unknown_skill"; readonly name: string }
    | { readonly type: "tool_not_mapped"; readonly name: string };

/** One file of the agents directory: a custom agent that resolves, or a draft with its gaps. */
export type AgentFile =
    | { readonly status: "ok"; readonly id: string; readonly path: string; readonly definition: CustomAgent }
    | { readonly status: "draft"; readonly id: string; readonly path: string; readonly gaps: readonly AgentFileGap[]; readonly definition?: CustomAgent };

/** What a reference of an agent file must resolve against. */
export type KnownReferences = {
    readonly builtinIds: ReadonlySet<string>;
    readonly connectors: ReadonlySet<string>;
    readonly mcpServers: ReadonlySet<string>;
    readonly skills: ReadonlySet<string>;
};

/** The text of a file split into its YAML frontmatter and its body, or `null` when the file opens with no frontmatter. */
export function splitFrontmatter(text: string): { readonly yaml: string; readonly body: string } | null {
    const normalized = text.replaceAll("\r\n", "\n");
    if (!normalized.startsWith("---\n")) return null;
    const end = normalized.indexOf("\n---", 3);
    if (end === -1) return null;
    const afterFence = normalized.indexOf("\n", end + 4);
    return { yaml: normalized.slice(4, end), body: afterFence === -1 ? "" : normalized.slice(afterFence + 1).trim() };
}

// `Bun.YAML.parse` throws on a syntax error.
const parseYaml = Result.fromThrowable(
    (yaml: string): unknown => Bun.YAML.parse(yaml),
    (cause): AgentFileGap => ({ type: "invalid_yaml", detail: messageOf(cause) }),
);

/** The frontmatter of an agent file and its prompt body. */
export type ParsedAgentFile = { readonly frontmatter: z.infer<typeof AgentFrontmatterSchema>; readonly body: string };

/** The frontmatter of an agent file, parsed and checked against its schema. */
export function parseAgentFrontmatter(text: string): Result<ParsedAgentFile, AgentFileGap> {
    const split = splitFrontmatter(text);
    if (split === null) return err({ type: "no_frontmatter" });
    return parseYaml(split.yaml).andThen((value): Result<ParsedAgentFile, AgentFileGap> => {
        const parsed = AgentFrontmatterSchema.safeParse(value);
        if (!parsed.success)
            return err({ type: "missing_fields", detail: parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ") });
        return ok({ frontmatter: parsed.data, body: split.body });
    });
}

/**
 * The MCP servers of a `mcpServers` field. A name references a server of the config. An object defines servers
 * inline, as Claude Code permits: the agent references each by its key, and the user must define it in the config.
 */
export function mcpServerNamesOf(entries: z.infer<typeof AgentFrontmatterSchema>["mcpServers"]): {
    readonly named: readonly string[];
    readonly inline: readonly string[];
} {
    const named: string[] = [];
    const inline: string[] = [];
    for (const entry of entries ?? []) {
        if (typeof entry === "string") named.push(entry);
        else inline.push(...Object.keys(entry));
    }
    return { named, inline };
}

/** The tool names of a `tools` field: a YAML list, or a comma list as Claude Code writes it. */
export function toolNamesOf(tools: string | readonly string[] | undefined): readonly string[] {
    if (tools === undefined) return [];
    const list = typeof tools === "string" ? tools.split(",") : tools;
    return list.map((tool) => tool.trim()).filter((tool) => tool.length > 0);
}

/**
 * One agent file checked against the references that exist. A file whose frontmatter does not parse, whose name is not
 * its file name, or whose references do not resolve is a draft with each gap. A draft never reaches the harness.
 */
export function checkAgentFile(id: string, path: string, text: string, known: KnownReferences): AgentFile {
    const parsed = parseAgentFrontmatter(text);
    if (parsed.isErr()) return { status: "draft", id, path, gaps: [parsed.error] };
    const { frontmatter, body } = parsed.value;
    const servers = mcpServerNamesOf(frontmatter.mcpServers);
    const role = frontmatter.role ?? "executor";
    const definition: CustomAgent = {
        id,
        name: frontmatter.name,
        role: "executor",
        description: frontmatter.description,
        prompt: body,
        connectors: frontmatter.connectors ?? [],
        mcp: [...servers.named, ...servers.inline],
        skills: frontmatter.skills ?? [],
    };
    const gaps: AgentFileGap[] = [];
    if (frontmatter.name !== id) gaps.push({ type: "name_mismatch", name: frontmatter.name });
    if (known.builtinIds.has(id)) gaps.push({ type: "builtin_id" });
    if (role !== "executor") gaps.push({ type: "role_not_allowed", role });
    for (const name of definition.connectors) if (!known.connectors.has(name)) gaps.push({ type: "unknown_connector", name });
    for (const name of servers.named) if (!known.mcpServers.has(name)) gaps.push({ type: "unknown_mcp_server", name });
    for (const name of servers.inline) gaps.push({ type: "inline_mcp_server", name });
    for (const name of definition.skills) if (!known.skills.has(name)) gaps.push({ type: "unknown_skill", name });
    for (const name of toolNamesOf(frontmatter.tools)) gaps.push({ type: "tool_not_mapped", name });
    return gaps.length === 0 ? { status: "ok", id, path, definition } : { status: "draft", id, path, gaps, definition };
}

/**
 * Each `*.md` file of the agents directory, checked. Two files can give one id only through a case difference on a
 * file system that keeps case, thus a repeated id marks each of its files as a draft. An absent directory has no
 * agents, which is the state of a new install.
 */
export function readAgentFiles(dir: string, known: KnownReferences): readonly AgentFile[] {
    let names: string[];
    try {
        names = readdirSync(dir).filter((name) => name.endsWith(".md"));
    } catch {
        return [];
    }
    const files = names.sort().flatMap((name) => {
        const path = join(dir, name);
        let text: string;
        try {
            text = readFileSync(path, "utf8");
        } catch {
            return [];
        }
        return [checkAgentFile(basename(name, ".md"), path, text, known)];
    });
    const counts = new Map<string, number>();
    for (const file of files) counts.set(file.id.toLowerCase(), (counts.get(file.id.toLowerCase()) ?? 0) + 1);
    return files.map((file): AgentFile => {
        if ((counts.get(file.id.toLowerCase()) ?? 0) < 2) return file;
        const gaps = file.status === "draft" ? file.gaps : [];
        return { status: "draft", id: file.id, path: file.path, gaps: [...gaps, { type: "duplicate_id" }], definition: file.definition };
    });
}

/**
 * The Markdown of an agent file: the frontmatter fields in a fixed order, then the prompt. `unmappedTools` are the
 * tools of an imported file that map to nothing: they stay under `tools`, thus the agent stays a draft until the user
 * removes them.
 */
export function renderAgentFile(definition: CustomAgent, unmappedTools: readonly string[] = []): string {
    const frontmatter: Record<string, unknown> = {
        name: definition.id,
        description: definition.description,
        role: "executor",
        connectors: [...definition.connectors],
        mcpServers: [...definition.mcp],
        skills: [...definition.skills],
    };
    if (unmappedTools.length > 0) frontmatter.tools = [...unmappedTools];
    return `---\n${Bun.YAML.stringify(frontmatter, null, 2).trimEnd()}\n---\n\n${definition.prompt.trim()}\n`;
}
