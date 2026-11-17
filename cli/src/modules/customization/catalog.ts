import {
    BUILTIN_AGENTS,
    CONNECTOR_IDS,
    SINGLE_AGENT_ROLES,
    createDirectorySkillStore,
    type AgentCatalog,
    type AgentEntry,
    type BuiltinAgentId,
    type ConnectorSettings,
    type McpOAuthProvider,
    type McpServerConfig,
    type RoleAssignments,
    type SingleAgentRole,
    type SkillStore,
} from "@inflexa-ai/harness";

import { mcpServerEntrySchema, readConfig, type Config, type McpServerEntry } from "../../lib/config.ts";
import { readAgentFiles, type AgentFile, type KnownReferences } from "./agent_files.ts";
import { resolveCredentialReferences, type CredentialReader } from "./credentials.ts";
import { entryAdditions, LOCALLY_EXTENDED_IDS } from "./local_builtins.ts";

/** Where the file catalog reads its content. */
export type FileCatalogOpts = {
    /** The built-in skills: the content of the release, or the repository tree in a development build. */
    readonly builtinSkillsDir: string;
    /** The custom skills of the user. A built-in skill keeps its name: a custom skill with the same name is left out. */
    readonly userSkillsDir: string;
    /** The custom agent files of the user. */
    readonly agentsDir: string;
    readonly credentials: CredentialReader;
    /** The OAuth provider of an HTTP server that signs in. Absent: no server signs in. */
    readonly mcpAuth?: (server: string, url: string) => McpOAuthProvider;
    /** The config of the moment. Each read of the catalog reads it again, thus an edit applies with no restart. */
    readonly readConfig?: () => Config;
};

/** One MCP server entry of the config, valid or with the reason that it is not. */
export type McpServerRecord = { readonly name: string; readonly entry: McpServerEntry } | { readonly name: string; readonly problem: string };

/** The catalog of the CLI: the agent files, the skill directories, and the config, read again at each use. */
export type FileCatalog = AgentCatalog & {
    /** Each agent file, the drafts included, for the listing of the agents. */
    readonly agentFiles: () => Promise<readonly AgentFile[]>;
    /** Each MCP server entry of the config, the invalid ones included. */
    readonly mcpRecords: () => readonly McpServerRecord[];
};

const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_AGENTS.map((agent) => agent.id));

function builtinIdOf(key: string): BuiltinAgentId | undefined {
    return BUILTIN_AGENTS.find((agent) => agent.id === key)?.id;
}

/** A valid MCP server name: a lowercase letter or digit first, then letters, digits, and hyphens, up to 32 characters. */
export function isValidMcpServerName(name: string): boolean {
    if (name.length === 0 || name.length > 32) return false;
    for (let index = 0; index < name.length; index += 1) {
        const char = name.charAt(index);
        const alnum = (char >= "a" && char <= "z") || (char >= "0" && char <= "9");
        if (!alnum && !(index > 0 && char === "-")) return false;
    }
    return true;
}

/** The agent that the user chose for each role that one agent fills. A key that is no such role is left out. */
export function roleAssignmentsOf(config: Config): RoleAssignments {
    const assignments: Partial<Record<SingleAgentRole, string>> = {};
    for (const role of SINGLE_AGENT_ROLES) {
        const chosen = config.roles?.[role];
        if (chosen !== undefined) assignments[role] = chosen;
    }
    return assignments;
}

export function mcpRecordsOf(config: Config): readonly McpServerRecord[] {
    return Object.entries(config.mcp ?? {}).map(([name, raw]): McpServerRecord => {
        if (!isValidMcpServerName(name)) return { name, problem: "the name must be lowercase letters, digits, and hyphens, up to 32 characters" };
        const parsed = mcpServerEntrySchema.safeParse(raw);
        return parsed.success
            ? { name, entry: parsed.data }
            : { name, problem: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
    });
}

async function resolveRecord(name: string, entry: McpServerEntry, opts: Pick<FileCatalogOpts, "credentials" | "mcpAuth">): Promise<McpServerConfig> {
    const resolveAll = async (values: Readonly<Record<string, string>>): Promise<Record<string, string>> =>
        Object.fromEntries(
            await Promise.all(Object.entries(values).map(async ([key, value]) => [key, await resolveCredentialReferences(value, opts.credentials)] as const)),
        );
    if (entry.type === "stdio") {
        return {
            name,
            transport: { kind: "stdio", command: entry.command, args: entry.args, env: await resolveAll(entry.env) },
            approval: entry.approval,
            scriptable: entry.scriptable,
        };
    }
    return {
        name,
        transport: {
            kind: "http",
            url: entry.url,
            headers: await resolveAll(entry.headers),
            auth: entry.auth === "oauth" && opts.mcpAuth !== undefined ? opts.mcpAuth(name, entry.url) : undefined,
        },
        approval: entry.approval,
        scriptable: entry.scriptable,
    };
}

export function createFileCatalog(opts: FileCatalogOpts): FileCatalog {
    const currentConfig = opts.readConfig ?? readConfig;
    const skills: SkillStore = createDirectorySkillStore([opts.builtinSkillsDir, opts.userSkillsDir]);

    const knownReferences = async (config: Config): Promise<KnownReferences> => ({
        builtinIds: BUILTIN_IDS,
        connectors: new Set(CONNECTOR_IDS),
        mcpServers: new Set(mcpRecordsOf(config).flatMap((record) => ("entry" in record ? [record.name] : []))),
        skills: new Set((await skills.list()).map((skill) => skill.name)),
    });

    const agentFiles = async (): Promise<readonly AgentFile[]> => {
        const config = currentConfig();
        return readAgentFiles(opts.agentsDir, await knownReferences(config));
    };

    return {
        skills,
        agentFiles,
        mcpRecords: () => mcpRecordsOf(currentConfig()),
        agents: async () => {
            const config = currentConfig();
            const changes = config.agents ?? {};
            const entries: AgentEntry[] = [];
            const builtinKeys = new Set([...Object.keys(changes), ...LOCALLY_EXTENDED_IDS]);
            for (const key of builtinKeys) {
                const id = builtinIdOf(key);
                if (id === undefined) continue;
                const change = changes[key] ?? {};
                const remove = change.remove ?? {};
                entries.push({ kind: "builtin", id, enabled: change.enabled ?? true, add: entryAdditions(id, change.add ?? {}, remove), remove });
            }
            const files = readAgentFiles(opts.agentsDir, await knownReferences(config));
            for (const file of files) {
                if (file.status !== "ok") continue;
                entries.push({ kind: "custom", enabled: changes[file.id]?.enabled ?? true, definition: file.definition });
            }
            return entries;
        },
        mcpServers: async () => {
            const records = mcpRecordsOf(currentConfig());
            const enabled = records.flatMap((record) => ("entry" in record && record.entry.enabled ? [record] : []));
            return Promise.all(enabled.map((record) => resolveRecord(record.name, record.entry, opts)));
        },
        connectors: () => {
            const settings = currentConfig().connectors ?? {};
            return Promise.resolve(
                Object.entries(settings).map(([id, value]): ConnectorSettings => ({
                    id,
                    enabled: true,
                    endpoint: value.endpoint,
                    credentials: value.credentials,
                })),
            );
        },
        roles: () => Promise.resolve(roleAssignmentsOf(currentConfig())),
        credential: (name) => opts.credentials.read(name),
    };
}
