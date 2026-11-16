import { cpSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import {
    BUILTIN_AGENTS,
    canAnswerApproval,
    CONNECTOR_IDS,
    describeConnectors,
    parseSkillFrontmatter,
    resolveCatalog,
    scanSkillRoots,
    revokeMcpSignIn,
    signInToMcpServer,
    type BuiltinAgent,
    type CatalogGap,
    type McpAuthorizationCallback,
    type ResolvedAgent,
    type ResolvedCatalog,
    type SkillRootProblem,
} from "@inflexa-ai/harness";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";

import type {
    AgentDetail,
    AgentGapView,
    AgentView,
    AttachmentKind,
    AttachmentsView,
    ConnectorView,
    CredentialView,
    McpRevocationView,
    McpServerView,
    PatchConnectorRequest,
    SkillList,
    SkillProblemView,
    SkillView,
} from "../../api/customization.ts";
import { messageOf } from "../../lib/cause.ts";
import {
    credentialSourceSchema,
    mcpServerEntrySchema,
    readConfig,
    writeConfig,
    type Config,
    type ConfigError,
    type CredentialSourceConfig,
    type McpServerEntry,
} from "../../lib/config.ts";
import { env } from "../../lib/env.ts";
import { errnoCode, mkdirResult, readFileResult, rmResult, writeFileResult } from "../../lib/fs.ts";
import { unknownRecordSchema } from "../../lib/json_record.ts";
import { getLogger } from "../../lib/log.ts";
import { openExternal } from "../../lib/open_external.ts";
import { runAfter } from "../../lib/timer.ts";
import { resolveHarnessConfig } from "../harness/config.ts";
import { agentIdOf, cloneDefinition, convertForeignAgent } from "./agent_import.ts";
import { renderAgentFile, splitFrontmatter, type AgentFile, type AgentFileGap } from "./agent_files.ts";
import { createFileCatalog, isValidMcpServerName, mcpRecordsOf, type FileCatalog } from "./catalog.ts";
import { createCredentialReader, type CredentialReader } from "./credentials.ts";
import { createMcpOAuthProvider, createMcpTokenStore, type McpTokenStore } from "./mcp_tokens.ts";

/** Why a customization operation failed. */
export type CustomizationError =
    | { readonly type: "unknown_agent"; readonly id: string }
    | { readonly type: "agent_exists"; readonly id: string }
    | { readonly type: "invalid_agent_id"; readonly id: string }
    | { readonly type: "not_an_executor"; readonly id: string }
    | { readonly type: "cannot_disable"; readonly id: string }
    | { readonly type: "builtin_agent"; readonly id: string }
    | { readonly type: "draft_unreadable"; readonly id: string; readonly path: string }
    | { readonly type: "unknown_reference"; readonly kind: AttachmentKind; readonly name: string }
    | { readonly type: "approval_needs_a_person"; readonly id: string; readonly name: string }
    | { readonly type: "import_failed"; readonly path: string; readonly detail: string }
    | { readonly type: "skill_dir_missing"; readonly path: string }
    | { readonly type: "invalid_skill"; readonly path: string; readonly detail: string }
    | { readonly type: "skill_exists"; readonly name: string; readonly builtin: boolean }
    | { readonly type: "unknown_connector"; readonly id: string }
    | { readonly type: "unknown_slot"; readonly id: string; readonly slot: string }
    | { readonly type: "invalid_credential_name"; readonly name: string }
    | { readonly type: "invalid_mcp_name"; readonly name: string }
    | { readonly type: "invalid_mcp_entry"; readonly detail: string }
    | { readonly type: "unknown_mcp_server"; readonly name: string }
    | { readonly type: "mcp_server_exists"; readonly name: string }
    | { readonly type: "mcp_server_invalid"; readonly name: string; readonly problem: string }
    | { readonly type: "not_oauth"; readonly name: string }
    | { readonly type: "sign_in_failed"; readonly name: string; readonly reason: string }
    | { readonly type: "io_failed"; readonly op: string; readonly cause: unknown }
    | ConfigError;

/** One line for a person, for each {@link CustomizationError}. */
export function customizationErrorMessage(e: CustomizationError): string {
    switch (e.type) {
        case "unknown_agent":
            return `No agent "${e.id}". \`inflexa agent ls\` lists the agents.`;
        case "agent_exists":
            return `An agent "${e.id}" exists already. Select a different id.`;
        case "invalid_agent_id":
            return `The id "${e.id}" is not permitted. An agent id is lowercase letters, digits, and hyphens.`;
        case "not_an_executor":
            return `The agent "${e.id}" is not an executor. Only an executor can be cloned.`;
        case "cannot_disable":
            return `The built-in agent "${e.id}" must stay on.`;
        case "builtin_agent":
            return `"${e.id}" is a built-in agent. Only a custom agent can be removed. \`inflexa agent disable\` turns off a built-in agent that can be off.`;
        case "draft_unreadable":
            return `The frontmatter of ${e.path} does not parse. Correct the file in a text editor first.`;
        case "unknown_reference":
            return `No ${referenceNoun(e.kind)} "${e.name}".`;
        case "approval_needs_a_person":
            return `The MCP server "${e.name}" asks approval for each call, and no person answers the agent "${e.id}": it runs in a run or inside a tool. Only the chat agent and the reporter can attach it. Set \`approval\` of the server to \`never\` in the config to attach it here.`;
        case "import_failed":
            return `The import of ${e.path} failed: ${e.detail}`;
        case "skill_dir_missing":
            return `No directory at ${e.path}.`;
        case "invalid_skill":
            return `${e.path} is not a skill: ${e.detail}`;
        case "skill_exists":
            return e.builtin
                ? `The name "${e.name}" belongs to a built-in skill. A custom skill needs a different name.`
                : `A custom skill "${e.name}" exists already.`;
        case "unknown_connector":
            return `No connector "${e.id}". \`inflexa connector ls\` lists the connectors.`;
        case "unknown_slot":
            return `The connector "${e.id}" has no credential slot "${e.slot}".`;
        case "invalid_credential_name":
            return `The credential name "${e.name}" is not permitted. Use lowercase letters, digits, hyphens, and underscores, up to 64 characters.`;
        case "invalid_mcp_name":
            return `The server name "${e.name}" is not permitted. A server name is lowercase letters, digits, and hyphens, up to 32 characters, and starts with a letter or a digit.`;
        case "invalid_mcp_entry":
            return `The MCP server entry is not correct: ${e.detail}`;
        case "unknown_mcp_server":
            return `No MCP server "${e.name}". \`inflexa mcp ls\` lists the servers.`;
        case "mcp_server_exists":
            return `An MCP server "${e.name}" exists already.`;
        case "mcp_server_invalid":
            return `The config entry of the MCP server "${e.name}" is not correct: ${e.problem}`;
        case "not_oauth":
            return `The MCP server "${e.name}" does not sign in with OAuth. Only an HTTP server with \`auth: "oauth"\` signs in.`;
        case "sign_in_failed":
            return `The sign-in to the MCP server "${e.name}" failed: ${e.reason}`;
        case "io_failed":
            return `The server could not ${e.op}: ${messageOf(e.cause)}`;
        case "config_write_failed":
            return `The server could not write the config: ${messageOf(e.cause)}`;
        default: {
            const _exhaustive: never = e;
            return _exhaustive;
        }
    }
}

function referenceNoun(kind: AttachmentKind): string {
    switch (kind) {
        case "connector":
            return "connector";
        case "mcp":
            return "MCP server";
        case "skill":
            return "skill";
        default: {
            const _exhaustive: never = kind;
            return _exhaustive;
        }
    }
}

/** What the customization operations read and write. Tests point each path and each effect at a temporary place. */
export type CustomizationOpts = {
    readonly agentsDir: string;
    readonly userSkillsDir: string;
    /** The built-in skills of this build, read at each call. `null` when the build has none, which a boot refuses. */
    readonly builtinSkillsDir: () => string | null;
    readonly readConfig: () => Config;
    readonly writeConfig: (config: Config) => Result<void, ConfigError>;
    readonly credentials: CredentialReader;
    readonly tokenStore: McpTokenStore;
    /** Open the authorization page of a sign-in. */
    readonly openBrowser: (url: URL) => void;
    readonly signIn: typeof signInToMcpServer;
    readonly revoke: typeof revokeMcpSignIn;
    /** How long a sign-in waits for the browser to come back. */
    readonly authTimeoutMs: number;
};

/** A person needs time to read the authorization page and to sign in, thus the wait is long. */
const AUTH_TIMEOUT_MS = 5 * 60_000;

/** The production {@link CustomizationOpts}: the paths of `env`, the config file, and the token store of this platform. */
export function defaultCustomizationOpts(): CustomizationOpts {
    const log = getLogger("customization");
    return {
        agentsDir: env.agentsDir,
        userSkillsDir: env.userSkillsDir,
        builtinSkillsDir: () => resolveHarnessConfig().skillsDir,
        readConfig,
        writeConfig,
        credentials: createCredentialReader(),
        tokenStore: createMcpTokenStore(),
        openBrowser: (url) => {
            openExternal(url.toString()).match(
                () => undefined,
                (e) => log.warn({ url: url.toString(), code: e.code }, "no browser opened for the MCP sign-in; open the URL by hand"),
            );
        },
        signIn: signInToMcpServer,
        revoke: revokeMcpSignIn,
        authTimeoutMs: AUTH_TIMEOUT_MS,
    };
}

/** The customization operations of the server. Each one reads the files and the config again, thus an edit applies at once. */
export type CustomizationService = {
    readonly listAgents: () => ResultAsync<AgentView[], CustomizationError>;
    readonly showAgent: (id: string) => ResultAsync<AgentDetail, CustomizationError>;
    readonly cloneAgent: (sourceId: string, newId: string) => ResultAsync<AgentDetail, CustomizationError>;
    readonly importAgent: (path: string) => ResultAsync<AgentDetail, CustomizationError>;
    readonly setAgentEnabled: (id: string, enabled: boolean) => ResultAsync<AgentDetail, CustomizationError>;
    readonly attach: (id: string, kind: AttachmentKind, name: string) => ResultAsync<AgentDetail, CustomizationError>;
    readonly detach: (id: string, kind: AttachmentKind, name: string) => ResultAsync<AgentDetail, CustomizationError>;
    readonly removeAgent: (id: string) => ResultAsync<void, CustomizationError>;
    readonly listSkills: () => ResultAsync<SkillList, CustomizationError>;
    readonly findSkills: (dir: string) => ResultAsync<SkillList, CustomizationError>;
    readonly importSkill: (dir: string) => ResultAsync<SkillView, CustomizationError>;
    readonly listConnectors: () => ResultAsync<ConnectorView[], CustomizationError>;
    readonly setConnector: (id: string, patch: PatchConnectorRequest) => ResultAsync<ConnectorView, CustomizationError>;
    readonly listCredentials: () => ResultAsync<CredentialView[], CustomizationError>;
    readonly setCredential: (name: string, source: CredentialSourceConfig) => ResultAsync<CredentialView, CustomizationError>;
    readonly listMcp: () => ResultAsync<McpServerView[], CustomizationError>;
    readonly addMcp: (name: string, entry: unknown) => ResultAsync<McpServerView, CustomizationError>;
    readonly setMcpEnabled: (name: string, enabled: boolean) => ResultAsync<McpServerView, CustomizationError>;
    readonly removeMcp: (name: string) => ResultAsync<void, CustomizationError>;
    readonly mcpAuth: (name: string) => ResultAsync<void, CustomizationError>;
    readonly mcpLogout: (name: string) => ResultAsync<McpRevocationView, CustomizationError>;
};

type AttachmentKey = "connectors" | "mcp" | "skills";

const KEY_OF: Readonly<Record<AttachmentKind, AttachmentKey>> = { connector: "connectors", mcp: "mcp", skill: "skills" };

/** The frontmatter field of an agent file for each kind. `mcpServers` is the field name of Claude Code subagents. */
const FRONTMATTER_KEY_OF: Readonly<Record<AttachmentKind, string>> = { connector: "connectors", mcp: "mcpServers", skill: "skills" };

/** The change of the user to one agent, as the config holds it. */
type AgentChange = NonNullable<Config["agents"]>[string];
type AttachmentLists = NonNullable<AgentChange["add"]>;

const stringListSchema = z.array(z.string());

const CREDENTIAL_NAME_MAX = 64;

/** A credential name: lowercase letters, digits, hyphens, and underscores, with a letter or a digit first. */
function isValidCredentialName(name: string): boolean {
    if (name.length === 0 || name.length > CREDENTIAL_NAME_MAX) return false;
    for (let index = 0; index < name.length; index += 1) {
        const char = name.charAt(index);
        const alnum = (char >= "a" && char <= "z") || (char >= "0" && char <= "9");
        if (!alnum && !(index > 0 && (char === "-" || char === "_"))) return false;
    }
    return true;
}

function attachmentsView(
    lists: { readonly connectors?: readonly string[]; readonly mcp?: readonly string[]; readonly skills?: readonly string[] } | undefined,
): AttachmentsView {
    return { connectors: [...(lists?.connectors ?? [])], mcp: [...(lists?.mcp ?? [])], skills: [...(lists?.skills ?? [])] };
}

function fileGapView(gap: AgentFileGap): AgentGapView {
    switch (gap.type) {
        case "no_frontmatter":
            return { reason: gap.type, message: "The file does not open with YAML frontmatter between `---` lines." };
        case "invalid_yaml":
            return { reason: gap.type, message: `The frontmatter does not parse: ${gap.detail}` };
        case "missing_fields":
            return { reason: gap.type, message: `The frontmatter has no correct value for: ${gap.detail}` };
        case "name_mismatch":
            return { reason: gap.type, reference: gap.name, message: `The name "${gap.name}" is not the file name.` };
        case "builtin_id":
            return { reason: gap.type, message: "The id is the id of a built-in agent." };
        case "duplicate_id":
            return { reason: gap.type, message: "A different file gives the same id." };
        case "role_not_allowed":
            return { reason: gap.type, reference: gap.role, message: `The role "${gap.role}" is not permitted. A custom agent is an executor.` };
        case "unknown_connector":
            return { reason: gap.type, reference: gap.name, message: `No connector "${gap.name}".` };
        case "unknown_mcp_server":
            return { reason: gap.type, reference: gap.name, message: `No MCP server "${gap.name}" in the config.` };
        case "unknown_skill":
            return { reason: gap.type, reference: gap.name, message: `No skill "${gap.name}".` };
        case "inline_mcp_server":
            return {
                reason: gap.type,
                reference: gap.name,
                message: `The file defines the MCP server "${gap.name}" inline. Add it with \`inflexa mcp add\`, then list only its name.`,
            };
        case "tool_not_mapped":
            return { reason: gap.type, reference: gap.name, message: `The tool "${gap.name}" maps to no connector or MCP server. Remove it from \`tools\`.` };
        default: {
            const _exhaustive: never = gap;
            return _exhaustive;
        }
    }
}

function catalogGapView(gap: CatalogGap): AgentGapView {
    const reference = gap.reference ?? "";
    switch (gap.reason) {
        case "unknown_connector":
            return { reason: gap.reason, reference, message: `No connector "${reference}". The agent runs without it.` };
        case "unknown_mcp_server":
            return { reason: gap.reason, reference, message: `No enabled MCP server "${reference}". The agent runs without it.` };
        case "unknown_skill":
            return { reason: gap.reason, reference, message: `No skill "${reference}". The agent runs without it.` };
        case "duplicate_id":
            return { reason: gap.reason, message: "A different agent has the same id." };
        case "builtin_id":
            return { reason: gap.reason, message: "The id is the id of a built-in agent." };
        case "role_not_allowed":
            return { reason: gap.reason, reference, message: `The role "${reference}" is not permitted. A custom agent is an executor.` };
        case "cannot_disable":
            return { reason: gap.reason, message: "The config turns off an agent that must stay on. The agent stays on." };
        case "scriptable_needs_no_approval":
            return { reason: gap.reason, message: "A scriptable MCP server needs `approval: never`. Its tools stay out of scripts." };
        case "approval_needs_a_person":
            return {
                reason: gap.reason,
                reference: gap.reference,
                message: `The MCP server "${gap.reference ?? ""}" asks approval for each call, and no person answers this agent. The agent runs without it.`,
            };
        default: {
            const _exhaustive: never = gap.reason;
            return _exhaustive;
        }
    }
}

/** The attachments of a built-in agent with a change applied, for an agent that the resolution leaves out because it is off. */
function mergedAttachments(agent: BuiltinAgent, change: AgentChange | undefined): AttachmentsView {
    const merge = (key: AttachmentKey): string[] => {
        const removed = new Set(change?.remove?.[key] ?? []);
        return [...new Set([...agent.defaults[key].filter((item) => !removed.has(item)), ...(change?.add?.[key] ?? [])])];
    };
    return { connectors: merge("connectors"), mcp: merge("mcp"), skills: merge("skills") };
}

/**
 * A change to a built-in agent with one attachment added or removed, kept as a difference from the defaults: a
 * default that the user attaches again leaves `remove`, and an added item that the user detaches leaves `add`.
 * Each empty list and each empty group is dropped, thus the config holds only the real difference.
 */
function changeAttachment(change: AgentChange, defaults: AttachmentsView, key: AttachmentKey, name: string, attach: boolean): AgentChange {
    const isDefault = defaults[key].includes(name);
    let add = (change.add?.[key] ?? []).filter((item) => item !== name);
    let remove = (change.remove?.[key] ?? []).filter((item) => item !== name);
    if (attach && !isDefault) add = [...add, name];
    if (!attach && isDefault) remove = [...remove, name];
    return pruneChange({ ...change, add: { ...change.add, [key]: add }, remove: { ...change.remove, [key]: remove } });
}

function pruneLists(lists: AttachmentLists | undefined): AttachmentLists | undefined {
    const out: AttachmentLists = {};
    for (const key of ["connectors", "mcp", "skills"] as const) {
        const items = lists?.[key] ?? [];
        if (items.length > 0) out[key] = items;
    }
    return Object.keys(out).length === 0 ? undefined : out;
}

function pruneChange(change: AgentChange): AgentChange {
    const out: AgentChange = {};
    if (change.enabled === false) out.enabled = false;
    const add = pruneLists(change.add);
    if (add !== undefined) out.add = add;
    const remove = pruneLists(change.remove);
    if (remove !== undefined) out.remove = remove;
    return out;
}

/** The config with the change of one agent replaced. An empty change removes the entry of the agent. */
function withAgentChange(config: Config, id: string, change: AgentChange): Config {
    const agents = Object.fromEntries(Object.entries(config.agents ?? {}).filter(([key]) => key !== id));
    const pruned = pruneChange(change);
    if (Object.keys(pruned).length > 0) agents[id] = pruned;
    return { ...config, agents: Object.keys(agents).length === 0 ? undefined : agents };
}

function withRecordEntry<T>(record: Readonly<Record<string, T>> | undefined, key: string, value: T | undefined): Record<string, T> | undefined {
    const out = Object.fromEntries(Object.entries(record ?? {}).filter(([candidate]) => candidate !== key));
    if (value !== undefined) out[key] = value;
    return Object.keys(out).length === 0 ? undefined : out;
}

function skillProblemMessage(problem: SkillRootProblem, builtinRoot: string | null): string {
    switch (problem.kind) {
        case "frontmatter":
            switch (problem.problem) {
                case "no_frontmatter":
                    return "The SKILL.md does not open with YAML frontmatter.";
                case "invalid_yaml":
                    return "The frontmatter of the SKILL.md does not parse.";
                case "missing_name_or_description":
                    return "The frontmatter of the SKILL.md has no `name` or no `description`.";
                default: {
                    const _exhaustive: never = problem.problem;
                    return _exhaustive;
                }
            }
        case "name_mismatch":
            return `The name "${problem.name}" is not the directory name.`;
        case "name_taken":
            return builtinRoot !== null && isInside(problem.by, builtinRoot)
                ? `The name "${problem.name}" belongs to the built-in skill at ${problem.by}. The agents read the built-in skill.`
                : `The name "${problem.name}" belongs to the skill at ${problem.by}.`;
        default: {
            const _exhaustive: never = problem;
            return _exhaustive;
        }
    }
}

function isInside(path: string, root: string): boolean {
    return path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Parse YAML without a throw: `Bun.YAML.parse` throws on a syntax error. */
function parseYamlRecord(yaml: string): Record<string, unknown> | undefined {
    let value: unknown;
    try {
        value = Bun.YAML.parse(yaml);
    } catch {
        return undefined;
    }
    const parsed = unknownRecordSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

/** `cpSync` throws on each failure. */
function copyDirectory(from: string, to: string): Result<void, CustomizationError> {
    return Result.fromThrowable(
        () => cpSync(from, to, { recursive: true, errorOnExist: true, force: false, dereference: true }),
        (cause): CustomizationError => ({ type: "io_failed", op: "copy the skill directory", cause }),
    )();
}

/** The {@link CustomizationService} over `opts`. */
export function createCustomizationService(opts: CustomizationOpts): CustomizationService {
    const log = getLogger("customization");

    const catalogOf = (config: Config): FileCatalog =>
        createFileCatalog({
            // A build with no built-in skills fails its boot, thus this path matters only to the listing of a broken
            // install. A path that does not exist reads as a root with no skills.
            builtinSkillsDir: opts.builtinSkillsDir() ?? join(opts.agentsDir, "no-builtin-skills"),
            userSkillsDir: opts.userSkillsDir,
            agentsDir: opts.agentsDir,
            credentials: opts.credentials,
            readConfig: () => config,
        });

    type AgentState = { readonly config: Config; readonly files: readonly AgentFile[]; readonly resolved: ResolvedCatalog; readonly catalog: FileCatalog };

    const loadAgents = (): ResultAsync<AgentState, CustomizationError> => {
        const config = opts.readConfig();
        const catalog = catalogOf(config);
        return ResultAsync.fromPromise(Promise.all([catalog.agentFiles(), resolveCatalog(catalog)]), (cause): CustomizationError => ({
            type: "io_failed",
            op: "read the agent catalog",
            cause,
        })).map(([files, resolved]) => ({ config, files, resolved, catalog }));
    };

    const gapsOf = (resolved: ResolvedCatalog, id: string): AgentGapView[] => resolved.gaps.filter((gap) => gap.subject === id).map(catalogGapView);

    const builtinDetail = (agent: BuiltinAgent, state: AgentState): AgentDetail => {
        const change = state.config.agents?.[agent.id];
        const resolved = state.resolved.agents.get(agent.id);
        return {
            id: agent.id,
            name: agent.name,
            kind: "builtin",
            draft: false,
            role: agent.role,
            description: agent.description,
            enabled: resolved !== undefined,
            canDisable: agent.canDisable,
            attachments: resolved === undefined ? mergedAttachments(agent, change) : attachmentsView(resolved.attachments),
            defaults: attachmentsView(agent.defaults),
            change: { add: attachmentsView(change?.add), remove: attachmentsView(change?.remove) },
            gaps: gapsOf(state.resolved, agent.id),
            prompt: agent.prompt ?? null,
        };
    };

    const customDetail = (file: AgentFile, state: AgentState): AgentDetail => {
        const enabled = state.config.agents?.[file.id]?.enabled ?? true;
        const definition = file.definition;
        const base = {
            id: file.id,
            name: definition?.name ?? file.id,
            kind: "custom" as const,
            role: definition?.role ?? "executor",
            description: definition?.description ?? "",
            enabled,
            canDisable: true,
            path: file.path,
            prompt: definition?.prompt ?? null,
        };
        if (file.status === "draft") {
            return { ...base, draft: true, attachments: attachmentsView(definition), gaps: file.gaps.map(fileGapView) };
        }
        const resolved = state.resolved.agents.get(file.id);
        return {
            ...base,
            draft: false,
            attachments: attachmentsView(resolved?.attachments ?? file.definition),
            gaps: gapsOf(state.resolved, file.id),
        };
    };

    /** The agent to clone. A built-in agent that the user turned off is absent from the resolution, thus it is merged here. */
    const cloneSource = (state: AgentState, id: string): ResolvedAgent | undefined => {
        const resolved = state.resolved.agents.get(id);
        const builtin = BUILTIN_AGENTS.find((agent) => agent.id === id);
        if (resolved !== undefined || builtin === undefined) return resolved;
        const attachments = mergedAttachments(builtin, state.config.agents?.[id]);
        return { id, name: builtin.name, role: builtin.role, description: builtin.description, prompt: builtin.prompt, builtin: true, attachments };
    };

    const agentDetails = (state: AgentState): AgentDetail[] => [
        ...BUILTIN_AGENTS.map((agent) => builtinDetail(agent, state)),
        ...state.files.map((file) => customDetail(file, state)),
    ];

    const findDetail = (id: string): ResultAsync<AgentDetail, CustomizationError> =>
        loadAgents().andThen((state) => {
            const found = agentDetails(state).find((agent) => agent.id === id);
            return found === undefined ? err<AgentDetail, CustomizationError>({ type: "unknown_agent", id }) : ok(found);
        });

    const writeConfigChange = (config: Config): Result<void, CustomizationError> => opts.writeConfig(config);

    /** Refuse a new agent id that is not a clean id, that a built-in agent has, or that a file of the directory gives. */
    const checkNewAgentId = (id: string, files: readonly AgentFile[]): Result<string, CustomizationError> => {
        if (id.length === 0 || agentIdOf(id) !== id) return err({ type: "invalid_agent_id", id });
        if (BUILTIN_AGENTS.some((agent) => agent.id === id) || files.some((file) => file.id.toLowerCase() === id)) return err({ type: "agent_exists", id });
        return ok(join(opts.agentsDir, `${id}.md`));
    };

    /** Write a new agent file. The exclusive flag refuses a file that appeared since the check of its id. */
    const writeNewAgentFile = (id: string, path: string, text: string): Result<void, CustomizationError> =>
        mkdirResult(opts.agentsDir, "make the agents directory").andThen(() =>
            writeFileResult(path, text, "write the agent file", { flag: "wx" }).mapErr((e): CustomizationError =>
                errnoCode(e.cause) === "EEXIST" ? { type: "agent_exists", id } : e,
            ),
        );

    const knownReference = async (config: Config, catalog: FileCatalog, kind: AttachmentKind, name: string): Promise<boolean> => {
        switch (kind) {
            case "connector":
                return CONNECTOR_IDS.includes(name);
            case "mcp":
                return mcpRecordsOf(config).some((record) => record.name === name && "entry" in record);
            case "skill":
                return (await catalog.skills.list()).some((skill) => skill.name === name);
            default: {
                const _exhaustive: never = kind;
                return _exhaustive;
            }
        }
    };

    /** Rewrite one list of the frontmatter of an agent file, and keep each other field and the prompt as they are. */
    const rewriteFileList = (file: AgentFile, kind: AttachmentKind, name: string, attach: boolean): Result<void, CustomizationError> =>
        readFileResult(file.path, "read the agent file").andThen((text): Result<void, CustomizationError> => {
            const split = splitFrontmatter(text);
            const frontmatter = split === null ? undefined : parseYamlRecord(split.yaml);
            if (split === null || frontmatter === undefined) return err({ type: "draft_unreadable", id: file.id, path: file.path });
            const key = FRONTMATTER_KEY_OF[kind];
            const current = stringListSchema.safeParse(frontmatter[key] ?? []);
            const items = (current.success ? current.data : []).filter((item) => item !== name);
            frontmatter[key] = attach ? [...items, name] : items;
            const yaml = Bun.YAML.stringify(frontmatter, null, 2).trimEnd();
            return writeFileResult(file.path, `---\n${yaml}\n---\n\n${split.body}\n`, "write the agent file");
        });

    const changeAttachmentOf = (id: string, kind: AttachmentKind, name: string, attach: boolean): ResultAsync<AgentDetail, CustomizationError> =>
        loadAgents()
            .andThen((state) =>
                ResultAsync.fromSafePromise(attach ? knownReference(state.config, state.catalog, kind, name) : Promise.resolve(true)).andThen(
                    (known): Result<void, CustomizationError> => {
                        if (!known) return err({ type: "unknown_reference", kind, name });
                        const builtin = BUILTIN_AGENTS.find((agent) => agent.id === id);
                        if (attach && kind === "mcp") {
                            const entry = mcpEntryOf(state.config, name);
                            const role = builtin?.role ?? "executor";
                            if (entry.isOk() && entry.value.approval === "always" && !canAnswerApproval(role))
                                return err({ type: "approval_needs_a_person", id, name });
                        }
                        if (builtin !== undefined) {
                            // Read the config again just before the write: the check above awaited, and a different
                            // request can have written the config in that time.
                            const config = opts.readConfig();
                            const change = changeAttachment(config.agents?.[id] ?? {}, attachmentsView(builtin.defaults), KEY_OF[kind], name, attach);
                            return writeConfigChange(withAgentChange(config, id, change));
                        }
                        const file = state.files.find((candidate) => candidate.id === id);
                        if (file === undefined) return err({ type: "unknown_agent", id });
                        return rewriteFileList(file, kind, name, attach);
                    },
                ),
            )
            .andThen(() => findDetail(id));

    const scanSkills = (): ResultAsync<{ readonly builtinRoot: string | null; readonly list: SkillList }, CustomizationError> => {
        const builtinRoot = opts.builtinSkillsDir();
        const roots = builtinRoot === null ? [opts.userSkillsDir] : [builtinRoot, opts.userSkillsDir];
        const kindOf = (directory: string): "builtin" | "custom" => (isInside(directory, opts.userSkillsDir) ? "custom" : "builtin");
        return ResultAsync.fromPromise(scanSkillRoots(roots), (cause): CustomizationError => ({
            type: "io_failed",
            op: "read the skill directories",
            cause,
        })).map(({ skills, problems }) => ({
            builtinRoot,
            list: {
                skills: skills.map((skill): SkillView => ({
                    name: skill.name,
                    description: skill.description,
                    kind: kindOf(skill.directory),
                    directory: skill.directory,
                })),
                problems: problems.map((problem): SkillProblemView => ({
                    directory: problem.directory,
                    kind: kindOf(problem.directory),
                    message: skillProblemMessage(problem, builtinRoot),
                })),
            },
        }));
    };

    const connectorView = async (definition: ReturnType<typeof describeConnectors>[number], config: Config): Promise<ConnectorView> => {
        const settings = config.connectors?.[definition.id];
        const slots = await Promise.all(
            Object.entries(definition.credentials).map(async ([slot, info]) => {
                const credential = settings?.credentials?.[slot] ?? slot;
                return {
                    slot,
                    required: info.required,
                    unlocks: info.unlocks,
                    credential,
                    resolves: (await opts.credentials.read(credential)) !== undefined,
                };
            }),
        );
        return {
            id: definition.id,
            description: definition.description,
            enabled: settings?.enabled ?? true,
            endpoint: settings?.endpoint,
            defaultEndpoint: definition.defaultEndpoint,
            slots,
        };
    };

    const credentialView = async (name: string, raw: unknown): Promise<CredentialView> => {
        const parsed = credentialSourceSchema.safeParse(raw);
        if (!parsed.success) return { name, problem: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
        return { name, source: parsed.data, resolves: (await opts.credentials.read(name)) !== undefined };
    };

    const mcpView = async (name: string, entry: McpServerEntry): Promise<McpServerView> => {
        if (entry.type === "http" && entry.auth === "oauth") {
            const stored = await opts.tokenStore.read(entry.url);
            return { name, entry, signedIn: stored?.tokens !== undefined };
        }
        return { name, entry };
    };

    /** The valid entry of a server, or the reason that the config has none. */
    const mcpEntryOf = (config: Config, name: string): Result<McpServerEntry, CustomizationError> => {
        const record = mcpRecordsOf(config).find((candidate) => candidate.name === name);
        if (record === undefined) return err({ type: "unknown_mcp_server", name });
        if ("problem" in record) return err({ type: "mcp_server_invalid", name, problem: record.problem });
        return ok(record.entry);
    };

    const oauthUrlOf = (name: string): Result<string, CustomizationError> =>
        mcpEntryOf(opts.readConfig(), name).andThen((entry) =>
            entry.type === "http" && entry.auth === "oauth" ? ok(entry.url) : err<string, CustomizationError>({ type: "not_oauth", name }),
        );

    const removeTokens = (url: string): ResultAsync<void, CustomizationError> =>
        ResultAsync.fromPromise(opts.tokenStore.remove(url), (cause): CustomizationError => ({ type: "io_failed", op: "delete the MCP tokens", cause }));

    /** Revoke the tokens of `url` at its authorization server, then delete them here, also when the revocation fails. */
    const signOut = (name: string, url: string): ResultAsync<McpRevocationView, CustomizationError> =>
        ResultAsync.fromSafePromise(opts.revoke({ url, provider: createMcpOAuthProvider({ server: name, url, store: opts.tokenStore }) })).andThen(
            (revocation) => {
                if (revocation.status === "failed")
                    log.warn({ server: name, reason: revocation.reason }, "the authorization server did not revoke the MCP tokens");
                return removeTokens(url).map(() => revocation);
            },
        );

    /**
     * The sign-in of one server. A loopback listener on a free port takes the redirect of the browser. The listener
     * and the timer stop when the sign-in settles, in each branch.
     */
    const signIn = async (name: string, url: string): Promise<Result<void, CustomizationError>> => {
        let deliver: (callback: McpAuthorizationCallback) => void = () => undefined;
        let refuse: (reason: Error) => void = () => undefined;
        const callback = new Promise<McpAuthorizationCallback>((resolvePromise, rejectPromise) => {
            deliver = resolvePromise;
            refuse = rejectPromise;
        });
        // A refusal can arrive when nothing waits on the callback yet, for example a stray request to the listener.
        // `signInToMcpServer` reads the refusal when it waits, thus this handler only keeps it from being unhandled.
        callback.catch(() => undefined);

        const listener = Result.fromThrowable(
            () =>
                Bun.serve({
                    hostname: "127.0.0.1",
                    port: 0,
                    fetch: (request) => {
                        const requestUrl = new URL(request.url);
                        if (requestUrl.pathname !== "/callback") return new Response("Not found.", { status: 404 });
                        const code = requestUrl.searchParams.get("code");
                        if (code === null || code.length === 0) {
                            const reason =
                                requestUrl.searchParams.get("error_description") ?? requestUrl.searchParams.get("error") ?? "the callback holds no code";
                            refuse(new Error(`the authorization server refused the sign-in: ${reason}`));
                            return new Response("The sign-in failed. Return to the terminal.", { status: 400 });
                        }
                        const iss = requestUrl.searchParams.get("iss");
                        deliver(iss === null ? { code } : { code, iss });
                        return new Response("The sign-in is complete. You can close this page.");
                    },
                }),
            (cause): CustomizationError => ({ type: "io_failed", op: "listen for the sign-in callback", cause }),
        )();
        if (listener.isErr()) return err(listener.error);
        const server = listener.value;
        const stopTimer = runAfter(opts.authTimeoutMs, () =>
            refuse(new Error(`no browser came back within ${Math.round(opts.authTimeoutMs / 60_000)} minutes`)),
        );
        try {
            const provider = createMcpOAuthProvider({
                server: name,
                url,
                store: opts.tokenStore,
                redirectUrl: new URL("/callback", server.url).toString(),
                openBrowser: opts.openBrowser,
            });
            const result = await opts.signIn({ url, provider, waitForCallback: () => callback });
            if (result.status === "failed") return err({ type: "sign_in_failed", name, reason: result.reason });
            return ok(undefined);
        } finally {
            stopTimer();
            // A graceful stop: the response to the browser that delivered the callback still goes out.
            void server.stop();
        }
    };

    return {
        listAgents: () => loadAgents().map((state) => agentDetails(state).map(({ prompt: _prompt, ...view }) => view)),

        showAgent: findDetail,

        cloneAgent: (sourceId, newId) =>
            loadAgents()
                .andThen((state): Result<void, CustomizationError> => {
                    const path = checkNewAgentId(newId, state.files);
                    if (path.isErr()) return err(path.error);
                    const cloned = cloneDefinition(cloneSource(state, sourceId), sourceId, newId);
                    if (cloned.isErr())
                        return err(cloned.error.type === "unknown_agent" ? { type: "unknown_agent", id: sourceId } : { type: "not_an_executor", id: sourceId });
                    return writeNewAgentFile(newId, path.value, renderAgentFile(cloned.value));
                })
                .andThen(() => findDetail(newId)),

        importAgent: (path) =>
            loadAgents()
                .andThen((state): Result<string, CustomizationError> => {
                    const text = readFileResult(path, "read the agent file to import");
                    if (text.isErr()) return err({ type: "import_failed", path, detail: messageOf(text.error.cause) });
                    const knownServers = new Set(mcpRecordsOf(state.config).map((record) => record.name));
                    const converted = convertForeignAgent(text.value, knownServers);
                    if (converted.isErr()) {
                        const detail = converted.error.type === "no_id" ? "the name gives no agent id" : fileGapView(converted.error.gap).message;
                        return err({ type: "import_failed", path, detail });
                    }
                    const { id, definition, unmappedTools } = converted.value;
                    const target = checkNewAgentId(id, state.files);
                    if (target.isErr()) return err(target.error);
                    return writeNewAgentFile(id, target.value, renderAgentFile(definition, unmappedTools)).map(() => id);
                })
                .andThen((id) => findDetail(id)),

        setAgentEnabled: (id, enabled) =>
            loadAgents()
                .andThen((state): Result<void, CustomizationError> => {
                    const builtin = BUILTIN_AGENTS.find((agent) => agent.id === id);
                    if (builtin !== undefined && !enabled && !builtin.canDisable) return err({ type: "cannot_disable", id });
                    if (builtin === undefined && !state.files.some((file) => file.id === id)) return err({ type: "unknown_agent", id });
                    const config = opts.readConfig();
                    const current = config.agents?.[id] ?? {};
                    return writeConfigChange(withAgentChange(config, id, { ...current, enabled: enabled ? undefined : false }));
                })
                .andThen(() => findDetail(id)),

        attach: (id, kind, name) => changeAttachmentOf(id, kind, name, true),

        detach: (id, kind, name) => changeAttachmentOf(id, kind, name, false),

        removeAgent: (id) =>
            loadAgents().andThen((state): Result<void, CustomizationError> => {
                if (BUILTIN_AGENTS.some((agent) => agent.id === id)) return err({ type: "builtin_agent", id });
                const file = state.files.find((candidate) => candidate.id === id);
                if (file === undefined) return err({ type: "unknown_agent", id });
                return rmResult(file.path, "delete the agent file").andThen(() => {
                    const config = opts.readConfig();
                    return config.agents?.[id] === undefined ? ok(undefined) : writeConfigChange(withAgentChange(config, id, {}));
                });
            }),

        listSkills: () => scanSkills().map(({ list }) => list),

        findSkills: (dir) => {
            const root = resolve(dir);
            if (!existsSync(root)) return errAsync({ type: "skill_dir_missing", path: root });
            return scanSkills().andThen(({ list }) =>
                ResultAsync.fromPromise(scanSkillRoots([root]), (cause): CustomizationError => ({ type: "io_failed", op: "read the directory", cause })).map(
                    ({ skills, problems }): SkillList => {
                        const found: { name: string; description: string; directory: string }[] = [...skills];
                        // The named directory can be one skill itself, not only a directory of skills.
                        const own = readFileResult(join(root, "SKILL.md"), "read the SKILL.md");
                        const foundProblems: SkillProblemView[] = problems.map((problem) => ({
                            directory: problem.directory,
                            kind: "found",
                            message: skillProblemMessage(problem, null),
                        }));
                        if (own.isOk()) {
                            const parsed = parseSkillFrontmatter(own.value);
                            if (parsed.ok) found.unshift({ ...parsed.skill, directory: root });
                            else
                                foundProblems.unshift({
                                    directory: root,
                                    kind: "found",
                                    message: skillProblemMessage({ kind: "frontmatter", directory: root, problem: parsed.problem }, null),
                                });
                        }
                        const taken = new Map(list.skills.map((skill) => [skill.name, skill]));
                        return {
                            skills: found.map((skill): SkillView => {
                                const existing = taken.get(skill.name);
                                const view: SkillView = { name: skill.name, description: skill.description, kind: "found", directory: skill.directory };
                                if (existing === undefined) return view;
                                return { ...view, conflict: `A ${existing.kind === "builtin" ? "built-in" : "custom"} skill "${skill.name}" exists already.` };
                            }),
                            problems: foundProblems,
                        };
                    },
                ),
            );
        },

        importSkill: (dir) => {
            const root = resolve(dir);
            return scanSkills().andThen(({ list }): Result<SkillView, CustomizationError> => {
                const text = readFileResult(join(root, "SKILL.md"), "read the SKILL.md");
                if (text.isErr()) return err({ type: "invalid_skill", path: root, detail: "the directory holds no readable SKILL.md" });
                const parsed = parseSkillFrontmatter(text.value);
                if (!parsed.ok) return err({ type: "invalid_skill", path: root, detail: `the frontmatter of the SKILL.md is not correct (${parsed.problem})` });
                const { name, description } = parsed.skill;
                // The name becomes the directory name of the copy, thus it must be a clean single path segment.
                if (agentIdOf(name) !== name)
                    return err({ type: "invalid_skill", path: root, detail: `the name "${name}" must be lowercase letters, digits, and hyphens` });
                const existing = list.skills.find((skill) => skill.name === name);
                if (existing?.kind === "builtin") return err({ type: "skill_exists", name, builtin: true });
                const target = join(opts.userSkillsDir, name);
                if (existing !== undefined || existsSync(target)) return err({ type: "skill_exists", name, builtin: false });
                return mkdirResult(opts.userSkillsDir, "make the skills directory")
                    .andThen(() => copyDirectory(root, target))
                    .map((): SkillView => ({ name, description, kind: "custom", directory: target }));
            });
        },

        listConnectors: () => {
            const config = opts.readConfig();
            return ResultAsync.fromPromise(
                Promise.all(describeConnectors().map((definition) => connectorView(definition, config))),
                (cause): CustomizationError => ({ type: "io_failed", op: "read the connectors", cause }),
            );
        },

        setConnector: (id, patch) => {
            const definition = describeConnectors().find((candidate) => candidate.id === id);
            if (definition === undefined) return errAsync({ type: "unknown_connector", id });
            const unknownSlot = Object.keys(patch.credentials ?? {}).find((slot) => !(slot in definition.credentials));
            if (unknownSlot !== undefined) return errAsync({ type: "unknown_slot", id, slot: unknownSlot });
            const config = opts.readConfig();
            const current = config.connectors?.[id] ?? {};
            const enabled = patch.enabled === undefined ? current.enabled : patch.enabled ? undefined : false;
            const endpoint =
                patch.endpoint === undefined ? current.endpoint : patch.endpoint === null || patch.endpoint.length === 0 ? undefined : patch.endpoint;
            const merged: Record<string, string | null> = { ...current.credentials, ...patch.credentials };
            // A slot reads the credential of its own name by default, thus that name is no difference to keep.
            const credentials = Object.fromEntries(
                Object.entries(merged).flatMap(([slot, name]) => (name === null || name.length === 0 || name === slot ? [] : [[slot, name] as const])),
            );
            const next: NonNullable<Config["connectors"]>[string] = {};
            if (enabled === false) next.enabled = false;
            if (endpoint !== undefined) next.endpoint = endpoint;
            if (Object.keys(credentials).length > 0) next.credentials = credentials;
            const written = writeConfigChange({
                ...config,
                connectors: withRecordEntry(config.connectors, id, Object.keys(next).length === 0 ? undefined : next),
            });
            if (written.isErr()) return errAsync(written.error);
            return ResultAsync.fromPromise(connectorView(definition, opts.readConfig()), (cause): CustomizationError => ({
                type: "io_failed",
                op: "read the connector",
                cause,
            }));
        },

        listCredentials: () => {
            const config = opts.readConfig();
            return ResultAsync.fromPromise(
                Promise.all(Object.entries(config.credentials ?? {}).map(([name, raw]) => credentialView(name, raw))),
                (cause): CustomizationError => ({ type: "io_failed", op: "read the credentials", cause }),
            );
        },

        setCredential: (name, source) => {
            if (!isValidCredentialName(name)) return errAsync({ type: "invalid_credential_name", name });
            const config = opts.readConfig();
            const written = writeConfigChange({ ...config, credentials: withRecordEntry<unknown>(config.credentials, name, source) });
            if (written.isErr()) return errAsync(written.error);
            return ResultAsync.fromPromise(credentialView(name, source), (cause): CustomizationError => ({
                type: "io_failed",
                op: "read the credential",
                cause,
            }));
        },

        listMcp: () =>
            ResultAsync.fromPromise(
                Promise.all(
                    mcpRecordsOf(opts.readConfig()).map((record): Promise<McpServerView> =>
                        "problem" in record ? Promise.resolve({ name: record.name, problem: record.problem }) : mcpView(record.name, record.entry),
                    ),
                ),
                (cause): CustomizationError => ({ type: "io_failed", op: "read the MCP servers", cause }),
            ),

        addMcp: (name, raw) => {
            if (!isValidMcpServerName(name)) return errAsync({ type: "invalid_mcp_name", name });
            const parsed = mcpServerEntrySchema.safeParse(raw);
            if (!parsed.success)
                return errAsync({
                    type: "invalid_mcp_entry",
                    detail: parsed.error.issues.map((issue) => `${issue.path.join(".") || "entry"}: ${issue.message}`).join("; "),
                });
            const config = opts.readConfig();
            if (config.mcp !== undefined && Object.hasOwn(config.mcp, name)) return errAsync({ type: "mcp_server_exists", name });
            const written = writeConfigChange({ ...config, mcp: withRecordEntry<unknown>(config.mcp, name, parsed.data) });
            if (written.isErr()) return errAsync(written.error);
            return ResultAsync.fromPromise(mcpView(name, parsed.data), (cause): CustomizationError => ({
                type: "io_failed",
                op: "read the MCP server",
                cause,
            }));
        },

        setMcpEnabled: (name, enabled) => {
            const config = opts.readConfig();
            const entry = mcpEntryOf(config, name);
            if (entry.isErr()) return errAsync(entry.error);
            const next: McpServerEntry = { ...entry.value, enabled };
            const written = writeConfigChange({ ...config, mcp: withRecordEntry<unknown>(config.mcp, name, next) });
            if (written.isErr()) return errAsync(written.error);
            return ResultAsync.fromPromise(mcpView(name, next), (cause): CustomizationError => ({ type: "io_failed", op: "read the MCP server", cause }));
        },

        removeMcp: (name) => {
            const config = opts.readConfig();
            if (config.mcp === undefined || !Object.hasOwn(config.mcp, name)) return errAsync({ type: "unknown_mcp_server", name });
            // A copy of the entry under a different name can share the URL, and with it the tokens: a removal deletes them for each copy.
            const entry = mcpEntryOf(config, name);
            const url = entry.isOk() && entry.value.type === "http" ? entry.value.url : undefined;
            const written = writeConfigChange({ ...config, mcp: withRecordEntry<unknown>(config.mcp, name, undefined) });
            if (written.isErr()) return errAsync(written.error);
            return url === undefined ? okAsync(undefined) : signOut(name, url).map(() => undefined);
        },

        mcpAuth: (name) => {
            const url = oauthUrlOf(name);
            if (url.isErr()) return errAsync(url.error);
            log.info({ server: name }, "an MCP sign-in starts");
            return new ResultAsync(signIn(name, url.value));
        },

        mcpLogout: (name) => {
            const url = oauthUrlOf(name);
            if (url.isErr()) return errAsync(url.error);
            return signOut(name, url.value);
        },
    };
}
