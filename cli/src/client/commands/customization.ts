import { resolve } from "node:path";

import type { Result } from "neverthrow";

import {
    ATTACHMENT_KINDS,
    type AgentDetail,
    type AgentView,
    type AttachmentKind,
    type AttachmentsView,
    type McpEntryView,
    type McpRevocationView,
    type McpServerView,
    type PatchAgentRequest,
    type PutCredentialRequest,
    type RegistryServerView,
    type SkillList,
} from "../../api/customization.ts";
import { fail, promptSecret } from "../../lib/cli.ts";
import { terminalEnv } from "../../lib/env.ts";
import { acceptPastedCallbacks, deliverCallback, pasteCallbackHint } from "../../lib/oauth_callback.ts";
import { openExternal, sshForwardCommand, type OpenExternalError } from "../../lib/open_external.ts";
import { describeClientError, DEFAULT_CLIENT_OPTS, type ClientError, type ClientOpts } from "../api.ts";
import {
    addMcpServer,
    chooseRoleAgent,
    cloneAgent,
    deleteAgent,
    deleteCredential,
    deleteMcpServer,
    fetchAgent,
    fetchAgents,
    fetchConnectors,
    fetchCredentials,
    fetchFoundSkills,
    fetchMcpCandidates,
    fetchMcpServers,
    fetchSkill,
    fetchSkills,
    findSkills,
    importAgent,
    exportAgent,
    deleteSkill,
    fetchFoundAgents,
    importMcpServer,
    installMcpServer,
    importSkill,
    exportSkill,
    patchAgent,
    patchConnector,
    patchMcpServer,
    putCredential,
    searchMcpRegistry,
    signInMcpServer,
    signOutMcpServer,
} from "../customization.ts";

/** The output flag of each read command. */
export type JsonFlag = { json?: boolean };

/**
 * The warning of `inflexa mcp add`. A durable run can recover a step after a crash, and the recovery can call a tool
 * of the server again, thus the user must know it before the server is attached to an agent.
 */
export const MCP_REPEAT_WARNING =
    "Warning: a recovery of a step can call a tool of this server again. A tool with a side effect, for example a write or a message, can then act two times.";

function failOn(e: ClientError): never {
    return fail(describeClientError(e));
}

function identity<T>(value: T): T {
    return value;
}

function printJson(value: unknown): void {
    console.log(JSON.stringify(value, null, 2));
}

/** Split `key=value`. The value can hold `=`. */
function keyValue(flag: string, text: string): readonly [string, string] {
    const at = text.indexOf("=");
    if (at <= 0) return fail(`${flag} takes key=value, and "${text}" has no key.`);
    return [text.slice(0, at), text.slice(at + 1)];
}

function attachmentKindOf(kind: string): AttachmentKind {
    const found = ATTACHMENT_KINDS.find((candidate) => candidate === kind);
    return found ?? fail(`The kind "${kind}" is not known. Use ${ATTACHMENT_KINDS.join(", ")}.`);
}

function listText(items: readonly string[]): string {
    return items.length === 0 ? "(none)" : items.join(", ");
}

function printAttachments(label: string, lists: AttachmentsView): void {
    console.log(`  ${label}`);
    console.log(`    connectors: ${listText(lists.connectors)}`);
    console.log(`    mcp:        ${listText(lists.mcp)}`);
    console.log(`    skills:     ${listText(lists.skills)}`);
}

function agentKindLabel(agent: AgentView): string {
    if (agent.draft) return "draft";
    return agent.kind === "builtin" ? "built-in" : "custom";
}

function printGaps(agent: AgentView, indent: string): void {
    for (const gap of agent.gaps) console.log(`${indent}! ${gap.message}`);
}

function printAgent(agent: AgentDetail): void {
    const active = agent.active && agent.role !== "executor" ? ", active" : "";
    console.log(`\n  ${agent.id}  (${agentKindLabel(agent)}, ${agent.role}, ${agent.enabled ? "on" : "off"}${active})`);
    if (agent.description.length > 0) console.log(`  ${agent.description}`);
    if (agent.path !== undefined) console.log(`  file: ${agent.path}`);
    printAttachments("attachments:", agent.attachments);
    if (agent.change !== undefined) {
        printAttachments("added by you:", agent.change.add);
        printAttachments("removed by you:", agent.change.remove);
    }
    printGaps(agent, "  ");
    console.log(`\n  prompt${agent.kind === "builtin" ? " (read-only)" : ""}:\n`);
    console.log(agent.prompt ?? "  (none: the file of the draft has no body)");
    console.log();
}

/** `inflexa agent ls`: the built-in agents, the custom agents, and the drafts with their gaps. */
export async function agentLs(flags: JsonFlag, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const list = (await fetchAgents(opts)).match(identity, failOn);
    if (flags.json === true) {
        printJson(list);
        return;
    }
    const { agents, roles } = list;
    const width = Math.max(...agents.map((agent) => agent.id.length));
    console.log();
    for (const agent of agents) {
        const active = agent.active && agent.role !== "executor" ? "  (active)" : "";
        console.log(
            `  ${agent.id.padEnd(width)}  ${agentKindLabel(agent).padEnd(8)}  ${agent.role.padEnd(11)}  ${agent.enabled ? "on " : "off"}  ${agent.description}${active}`,
        );
        printGaps(agent, `  ${" ".repeat(width)}  `);
    }
    console.log("\n  Roles:");
    for (const role of roles) {
        console.log(`    ${role.role.padEnd(11)}  ${role.activeAgentId ?? "(off)"}`);
        for (const gap of role.gaps) console.log(`    ${" ".repeat(11)}  ! ${gap.message}`);
    }
    console.log();
}

/** `inflexa agent show <id>`: one agent, its attachments, the change of the user, and its gaps. */
export async function agentShow(id: string, flags: JsonFlag, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const agent = (await fetchAgent(id, opts)).match(identity, failOn);
    if (flags.json === true) {
        printJson(agent);
        return;
    }
    printAgent(agent);
}

/** `inflexa agent clone <id> <new-id>`: copy an agent into a new agent file of the same role. */
export async function agentClone(
    id: string,
    newId: string,
    flags: { description?: string; use?: boolean },
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): Promise<void> {
    const agent = (await cloneAgent(id, newId, flags.description, opts)).match(identity, failOn);
    console.log(`Cloned "${id}" to "${agent.id}". \`inflexa agent set ${agent.id}\` changes its description and its prompt.`);
    if (agent.role === "executor") return;
    if (flags.use !== true) {
        console.log(`\`inflexa agent use ${agent.id}\` makes it the ${agent.role} agent.`);
        return;
    }
    const role = (await chooseRoleAgent(agent.role, agent.id, opts)).match(identity, failOn);
    console.log(`The ${role.role} agent is "${role.activeAgentId ?? agent.id}".`);
}

/** `inflexa agent use <id>`: make an agent the active agent of its role. The built-in agent of the role restores the default. */
export async function agentUse(id: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const agent = (await fetchAgent(id, opts)).match(identity, failOn);
    if (agent.role === "executor")
        fail(`"${id}" is an executor. Each executor that is on is available to the plans, thus \`inflexa agent enable ${id}\` is enough.`);
    const role = (await chooseRoleAgent(agent.role, id, opts)).match(identity, failOn);
    console.log(`The ${role.role} agent is "${role.activeAgentId ?? id}".`);
}

/** `inflexa agent find`: the agent files in the agent directories of other harnesses. */
export async function agentFind(flags: JsonFlag, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const list = (await fetchFoundAgents(opts)).match(identity, failOn);
    if (flags.json === true) {
        printJson(list);
        return;
    }
    const width = Math.max(0, ...list.agents.map((agent) => agent.id.length));
    console.log();
    if (list.agents.length === 0) console.log("  No agent files.");
    for (const agent of list.agents) {
        console.log(`  ${agent.id.padEnd(width)}  ${agent.source}  ${agent.path}`);
        if (agent.conflict !== undefined) console.log(`  ${" ".repeat(width)}  ! ${agent.conflict}`);
    }
    for (const problem of list.problems) console.log(`  ! ${problem.path}: ${problem.message}`);
    console.log();
}

/** The flags of `agent import` and `skill import`. */
type ImportFlags = { analysis?: string; replace?: boolean };

/**
 * The body of an import of `path`. With `--analysis`, the server reads a relative path inside the workspace of the
 * analysis, thus the path goes as it is. Without it, a relative path reads from the working directory.
 */
function importBodyOf(path: string, flags: ImportFlags): { path: string; analysis?: string; replace?: boolean } {
    const body: { path: string; analysis?: string; replace?: boolean } = { path: flags.analysis === undefined ? resolve(path) : path };
    if (flags.analysis !== undefined) body.analysis = flags.analysis;
    if (flags.replace === true) body.replace = true;
    return body;
}

/** The line for the copy that a replace kept. An import of that path with `--replace` restores it. */
function printPrevious(previous: string | undefined): void {
    if (previous !== undefined) console.log(`The replaced version is in ${previous}. An import of that path with \`--replace\` restores it.`);
}

/** `inflexa agent export <id> <file>`: copy the file of a custom agent, for example into a workspace to edit it and import it again. */
export async function agentExport(id: string, file: string, flags: ImportFlags, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const exported = (await exportAgent(id, importBodyOf(file, flags), opts)).match(identity, failOn);
    console.log(
        `Copied the agent "${id}" to ${flags.analysis === undefined ? exported.path : file}. \`inflexa agent import\` with \`--replace\` takes the edited copy back.`,
    );
}

/** `inflexa agent import <file...>`: convert agent files of other harnesses. A file with gaps is kept as a draft. */
export async function agentImport(files: readonly string[], flags: ImportFlags & { role?: string }, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    for (const file of files) {
        const body = importBodyOf(file, flags);
        const agent = (await importAgent(flags.role === undefined ? body : { ...body, role: flags.role }, opts)).match(identity, failOn);
        console.log(`Imported "${agent.id}" as a ${agent.role} agent to ${agent.path ?? agent.id}.`);
        printPrevious(agent.previous);
        if (agent.draft) {
            console.log("The agent is a draft until you correct these gaps in the file:");
            printGaps(agent, "  ");
        }
    }
}

/** `inflexa agent set <id>`: change the description or the prompt body of a custom agent. */
export async function agentSet(
    id: string,
    flags: { description?: string; prompt?: string; promptFile?: string; analysis?: string },
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): Promise<void> {
    const promptGiven = flags.prompt !== undefined || flags.promptFile !== undefined;
    if (flags.description === undefined && !promptGiven) fail("Give --description, --prompt, or --prompt-file.");
    if (flags.prompt !== undefined && flags.promptFile !== undefined) fail("Give --prompt or --prompt-file, not both.");
    const body: PatchAgentRequest = {};
    if (flags.description !== undefined) body.description = flags.description;
    if (flags.prompt !== undefined) body.prompt = flags.prompt;
    if (flags.promptFile !== undefined) {
        // With `--analysis`, the server reads a relative path inside the workspace of the analysis.
        body.promptPath = flags.analysis === undefined ? resolve(flags.promptFile) : flags.promptFile;
        if (flags.analysis !== undefined) body.analysis = flags.analysis;
    }
    const agent = (await patchAgent(id, body, opts)).match(identity, failOn);
    const changed = [flags.description === undefined ? "" : "description", promptGiven ? "prompt" : ""].filter((part) => part.length > 0).join(" and ");
    console.log(`Changed the ${changed} of "${agent.id}".`);
    printGaps(agent, "  ");
    if (agent.role === "chat") console.log("The chat agent gets the change from the next message of the user.");
}

/** `inflexa agent enable <id>` and `inflexa agent disable <id>`. */
export async function agentSetEnabled(ids: readonly string[], enabled: boolean, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    for (const id of ids) {
        (await patchAgent(id, { enabled }, opts)).match(identity, failOn);
        console.log(`The agent "${id}" is ${enabled ? "on" : "off"}.`);
    }
}

/** `inflexa agent attach <id> <kind> <name...>` and `inflexa agent detach <id> <kind> <name...>`. The gaps print once, after the last name. */
export async function agentAttach(id: string, kind: string, names: readonly string[], attach: boolean, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const attachmentKind = attachmentKindOf(kind);
    let agent: AgentDetail | undefined;
    for (const name of names) {
        const change = { kind: attachmentKind, name };
        agent = (await patchAgent(id, attach ? { attach: change } : { detach: change }, opts)).match(identity, failOn);
        console.log(attach ? `Attached the ${kind} "${name}" to "${id}".` : `Detached the ${kind} "${name}" from "${id}".`);
    }
    if (agent === undefined) return;
    printGaps(agent, "  ");
    // A chat reads its catalog at the start of each turn, thus the turn that runs this command keeps its tools.
    if (agent.role === "chat") console.log("The chat agent gets the change from the next message of the user.");
}

/** `inflexa agent rm <id>`: delete a custom agent file. */
export async function agentRm(ids: readonly string[], opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    for (const id of ids) {
        (await deleteAgent(id, opts)).match(identity, failOn);
        console.log(`Removed the agent "${id}".`);
    }
}

function printSkills(list: SkillList): void {
    const width = Math.max(0, ...list.skills.map((skill) => skill.name.length));
    console.log();
    if (list.skills.length === 0) console.log("  No skills.");
    for (const skill of list.skills) {
        const title = skill.title === undefined ? "" : `${skill.title}  `;
        console.log(
            `  ${skill.name.padEnd(width)}  ${skill.kind.padEnd(8)}  ${title}${skill.category === undefined ? "" : `[${skill.category}]  `}${skill.directory}`,
        );
        if (skill.conflict !== undefined) console.log(`  ${" ".repeat(width)}  ! ${skill.conflict}`);
    }
    for (const problem of list.problems) console.log(`  ! ${problem.directory}: ${problem.message}`);
    console.log();
}

/** `inflexa skill ls`: the built-in and the custom skills, and each custom skill that the store leaves out. */
export async function skillLs(flags: JsonFlag, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const list = (await fetchSkills(opts)).match(identity, failOn);
    if (flags.json === true) {
        printJson(list);
        return;
    }
    printSkills(list);
}

/** `inflexa skill show <name>`: one skill with its text. */
export async function skillShow(name: string, flags: JsonFlag, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const skill = (await fetchSkill(name, opts)).match(identity, failOn);
    if (flags.json === true) {
        printJson(skill);
        return;
    }
    console.log(`\n  ${skill.title ?? skill.name}  (${skill.kind}${skill.category === undefined ? "" : `, ${skill.category}`})`);
    console.log(`  ${skill.directory}`);
    if (skill.tags.length > 0) console.log(`  tags: ${skill.tags.join(", ")}`);
    if (skill.files.length > 0) console.log(`  files: ${skill.files.join(", ")}`);
    console.log(`\n${skill.body}`);
}

/** `inflexa skill find [dir]`: the skills in a directory, or in the usual skill directories of other harnesses. */
export async function skillFind(dir: string | undefined, flags: JsonFlag, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const found = dir === undefined ? await fetchFoundSkills(opts) : await findSkills(resolve(dir), opts);
    const list = found.match(identity, failOn);
    if (flags.json === true) {
        printJson(list);
        return;
    }
    printSkills(list);
}

/** `inflexa skill export <name> <dir>`: copy a skill, for example into a workspace to edit it and import it again. */
export async function skillExport(name: string, dir: string, flags: ImportFlags, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const exported = (await exportSkill(name, importBodyOf(dir, flags), opts)).match(identity, failOn);
    console.log(
        `Copied the skill "${name}" to ${flags.analysis === undefined ? exported.path : dir}. \`inflexa skill import\` with \`--replace\` takes the edited copy back.`,
    );
}

/** `inflexa skill import <dir>`: copy a skill directory into the custom skills. */
export async function skillImport(dirs: readonly string[], flags: ImportFlags, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    for (const dir of dirs) {
        const skill = (await importSkill(importBodyOf(dir, flags), opts)).match(identity, failOn);
        console.log(`Imported the skill "${skill.name}" to ${skill.directory}.`);
        printPrevious(skill.previous);
    }
}

/** `inflexa skill rm <name...>`: delete custom skills. */
export async function skillRm(names: readonly string[], opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    for (const name of names) {
        (await deleteSkill(name, opts)).match(identity, failOn);
        console.log(`Removed the skill "${name}".`);
    }
}

/** `inflexa connector ls`: each connector, its settings, and whether each credential gives a value. */
export async function connectorLs(flags: JsonFlag, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const { connectors } = (await fetchConnectors(opts)).match(identity, failOn);
    if (flags.json === true) {
        printJson({ connectors });
        return;
    }
    const width = Math.max(...connectors.map((connector) => connector.id.length));
    let category = "";
    for (const connector of connectors) {
        if (connector.category !== category) {
            category = connector.category;
            console.log(`\n  ${category}`);
        }
        console.log(`  ${connector.id.padEnd(width)}  ${connector.description}`);
        const endpoint = connector.endpoint ?? connector.defaultEndpoint;
        if (endpoint !== undefined) console.log(`  ${" ".repeat(width)}  endpoint: ${endpoint}${connector.endpoint === undefined ? "" : " (yours)"}`);
        for (const slot of connector.slots) {
            const state = slot.resolves ? "set" : "not set";
            console.log(
                `  ${" ".repeat(width)}  ${slot.required ? "needs" : "can use"} credential "${slot.credential}" (${state})${slot.unlocks === undefined ? "" : ` for ${slot.unlocks}`}`,
            );
        }
    }
    console.log();
}

/** The flags of `inflexa connector set`. */
export type ConnectorSetFlags = { endpoint?: string; credential?: string[] };

/** `inflexa connector set <id>`: point a connector at an endpoint, and name its credentials. Each agent chooses its connectors. */
export async function connectorSet(id: string, flags: ConnectorSetFlags, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const credentials = Object.fromEntries((flags.credential ?? []).map((text) => keyValue("--credential", text)));
    const body = { endpoint: flags.endpoint, credentials: Object.keys(credentials).length === 0 ? undefined : credentials };
    const connector = (await patchConnector(id, body, opts)).match(identity, failOn);
    console.log(`Changed the connector "${connector.id}".`);
}

/** `inflexa credential ls`: each credential, where its value comes from, and whether it gives one. Never the value. */
export async function credentialLs(flags: JsonFlag, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const { credentials } = (await fetchCredentials(opts)).match(identity, failOn);
    if (flags.json === true) {
        printJson({ credentials });
        return;
    }
    console.log();
    if (credentials.length === 0) console.log("  No credentials. `inflexa credential set <name> --env <VAR>` declares one.");
    for (const credential of credentials) {
        if ("problem" in credential) {
            console.log(`  ${credential.name}  ! ${credential.problem}`);
            continue;
        }
        const from =
            credential.source.kind === "env"
                ? `env ${credential.source.var}`
                : credential.source.kind === "command"
                  ? `command ${credential.source.command}`
                  : "stored";
        console.log(`  ${credential.name}  ${from}  (${credential.resolves ? "gives a value" : "gives no value"})`);
    }
    console.log();
}

/** The flags of `inflexa credential set`. */
export type CredentialSetFlags = { env?: string; command?: string; format?: string; ttlMs?: string };

/**
 * `inflexa credential set <name>`: declare an environment variable or a helper command as the source of a credential,
 * or, with neither, type the value in a masked prompt. The Keychain or a `0600` file keeps a typed value.
 */
export async function credentialSet(name: string, flags: CredentialSetFlags, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    if (flags.env !== undefined && flags.command !== undefined) fail("Give --env <VAR> or --command <command>, not both.");
    let source: PutCredentialRequest;
    if (flags.env === undefined && flags.command === undefined) {
        // A typed value needs a person at a terminal, thus the chat agent, which runs with no terminal, can never give one.
        source = { kind: "stored", value: await promptSecret(`The value of "${name}"`) };
    } else if (flags.env !== undefined) {
        source = { kind: "env", var: flags.env };
    } else {
        const format =
            flags.format === undefined
                ? undefined
                : flags.format === "raw" || flags.format === "exec-credential"
                  ? flags.format
                  : fail("--format is raw or exec-credential.");
        const ttlMs = flags.ttlMs === undefined ? undefined : Number(flags.ttlMs);
        if (ttlMs !== undefined && (!Number.isInteger(ttlMs) || ttlMs <= 0)) fail("--ttl-ms is a positive whole number.");
        source = { kind: "command", command: flags.command ?? "", format, ttlMs };
    }
    const credential = (await putCredential(name, source, opts)).match(identity, failOn);
    const state = "resolves" in credential && credential.resolves ? "It gives a value now." : "It gives no value now.";
    console.log(`Set the credential "${name}". ${state}`);
}

/** `inflexa credential rm <name>`: remove a credential and its stored value. */
export async function credentialRm(names: readonly string[], opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    for (const name of names) {
        (await deleteCredential(name, opts)).match(identity, failOn);
        console.log(`Removed the credential "${name}".`);
    }
}

function mcpEntryText(entry: McpEntryView): string {
    const target = entry.type === "stdio" ? [entry.command, ...entry.args].join(" ") : entry.url;
    return `${entry.type}  ${target}  approval: ${entry.approval}${entry.scriptable ? "  scriptable" : ""}`;
}

function printMcpServer(server: McpServerView): void {
    if ("problem" in server) {
        console.log(`  ${server.name}  ! ${server.problem}`);
        return;
    }
    const signIn = server.signedIn === undefined ? "" : server.signedIn ? "  signed in" : "  not signed in";
    console.log(`  ${server.name}  ${server.entry.enabled ? "on " : "off"}  ${mcpEntryText(server.entry)}${signIn}`);
    if (server.startFailure !== undefined)
        console.log(`  ${" ".repeat(server.name.length)}  ! did not start at ${server.startFailure.at}: ${server.startFailure.reason}`);
}

/** `inflexa mcp ls`: each MCP server of the config, valid or with its problem, and the sign-in state of each OAuth server. */
export async function mcpLs(flags: JsonFlag, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const { servers } = (await fetchMcpServers(opts)).match(identity, failOn);
    if (flags.json === true) {
        printJson({ servers });
        return;
    }
    console.log();
    if (servers.length === 0) console.log("  No MCP servers. `inflexa mcp add` adds one.");
    for (const server of servers) printMcpServer(server);
    console.log();
}

/** The flags of `inflexa mcp add`. */
export type McpAddFlags = { url?: string; header?: string[]; oauth?: boolean; env?: string[]; approval?: string; scriptable?: boolean; disabled?: boolean };

/** `inflexa mcp add <name>`: add a local command (`-- <command> [args...]`) or an HTTP server (`--url`). */
export async function mcpAdd(name: string, command: readonly string[], flags: McpAddFlags, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const common = { approval: flags.approval, scriptable: flags.scriptable === true, enabled: flags.disabled !== true };
    let entry: Record<string, unknown>;
    if (flags.url !== undefined) {
        if (command.length > 0) fail("Give --url or a command, not both.");
        const headers = Object.fromEntries((flags.header ?? []).map((text) => keyValue("--header", text)));
        entry = { type: "http", url: flags.url, headers, auth: flags.oauth === true ? "oauth" : undefined, ...common };
    } else {
        const [executable, ...args] = command;
        if (executable === undefined) fail("Give --url <url>, or the command of the server after `--`.");
        if (flags.oauth === true || (flags.header ?? []).length > 0) fail("--oauth and --header apply to an HTTP server only.");
        const env = Object.fromEntries((flags.env ?? []).map((text) => keyValue("--env", text)));
        entry = { type: "stdio", command: executable, args, env, ...common };
    }
    const server = (await addMcpServer({ name, entry }, opts)).match(identity, failOn);
    console.log(MCP_REPEAT_WARNING);
    console.log(`Added the MCP server "${name}".`);
    printMcpServer(server);
    if ("entry" in server && server.entry.type === "http" && server.entry.auth === "oauth") console.log(`Run \`inflexa mcp auth ${name}\` to sign in.`);
}

/** `inflexa mcp enable <name>` and `inflexa mcp disable <name>`. */
export async function mcpSetEnabled(names: readonly string[], enabled: boolean, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    for (const name of names) {
        (await patchMcpServer(name, enabled, opts)).match(identity, failOn);
        console.log(`The MCP server "${name}" is ${enabled ? "on" : "off"}.`);
    }
}

/** `inflexa mcp rm <name>`: remove an MCP server, its tokens, and its client registration. */
export async function mcpRm(names: readonly string[], opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    for (const name of names) {
        (await deleteMcpServer(name, opts)).match(identity, failOn);
        console.log(`Removed the MCP server "${name}".`);
    }
}

/** What `inflexa mcp auth` prints, opens, and reads. Tests replace each one. */
export type McpAuthOpts = ClientOpts & {
    readonly write: (line: string) => void;
    readonly open: (url: string) => Result<void, OpenExternalError>;
    /** `SSH_CONNECTION`, or `null`. */
    readonly sshConnection: string | null;
    /** Where a pasted callback URL comes from. `null`: no terminal to paste into. */
    readonly input: NodeJS.ReadableStream | null;
    readonly deliver: (url: URL) => Promise<Result<void, string>>;
};

/** The production {@link McpAuthOpts}. */
export const DEFAULT_MCP_AUTH_OPTS: McpAuthOpts = {
    ...DEFAULT_CLIENT_OPTS,
    write: (line) => console.log(line),
    open: (url) => openExternal(url),
    sshConnection: terminalEnv.sshConnection,
    input: process.stdin.isTTY ? process.stdin : null,
    deliver: (url) => deliverCallback(url),
};

/**
 * `inflexa mcp auth <name>`: sign in to an MCP server in the browser. The command prints the authorization URL
 * and opens it. The callback waits on a loopback port of this machine. A browser on a different computer cannot
 * reach it, thus the command also takes a pasted callback URL, and over SSH it prints the port-forward command.
 */
export async function mcpAuth(name: string, opts: McpAuthOpts = DEFAULT_MCP_AUTH_OPTS): Promise<void> {
    const frames = (await signInMcpServer(name, opts)).match(identity, failOn);
    let stopPaste: (() => void) | null = null;
    try {
        for await (const item of frames) {
            const frame = item.match(identity, failOn);
            switch (frame.type) {
                case "authorize": {
                    const callback = new URL(frame.callbackUrl);
                    const port = Number(callback.port);
                    opts.write(`Sign in to "${name}" in a browser. The command waits up to 5 minutes for you to finish.\n\n  ${frame.url}\n`);
                    // The URL is printed above, thus a failed open needs no word of its own.
                    opts.open(frame.url).match(
                        () => undefined,
                        () => undefined,
                    );
                    if (opts.sshConnection !== null)
                        opts.write(`Over SSH, forward the callback port first, on your computer: ${sshForwardCommand(port, opts.sshConnection)}`);
                    if (opts.input !== null) {
                        opts.write(pasteCallbackHint(callback));
                        stopPaste = acceptPastedCallbacks(callback, { input: opts.input, say: opts.write, deliver: opts.deliver });
                    }
                    break;
                }
                case "signed_in":
                    opts.write(`Signed in to "${name}".`);
                    return;
                case "failed":
                    return fail(frame.error.message);
                default: {
                    const exhaustive: never = frame;
                    throw new Error(`unhandled MCP sign-in frame: ${JSON.stringify(exhaustive)}`);
                }
            }
        }
        fail(`The server ended the sign-in to "${name}" with no outcome. \`inflexa mcp ls\` shows if it signed in.`);
    } finally {
        stopPaste?.();
    }
}

function revocationText(revocation: McpRevocationView): string {
    switch (revocation.status) {
        case "revoked":
            return "The server revoked the tokens.";
        case "no_endpoint":
            return "The server has no revocation endpoint: the local tokens are deleted, and the server tokens expire on their own.";
        case "not_signed_in":
            return "No tokens were stored.";
        case "failed":
            return `The server did not revoke the tokens (${revocation.reason}). The local tokens are deleted.`;
        default: {
            const _exhaustive: never = revocation;
            return _exhaustive;
        }
    }
}

/** `inflexa mcp logout <name>`: delete the stored tokens of an MCP server. */
export async function mcpLogout(name: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const { revocation } = (await signOutMcpServer(name, opts)).match(identity, failOn);
    console.log(`Signed out of "${name}". ${revocationText(revocation)}`);
}

/** `inflexa mcp find`: the MCP servers in the configs of other harnesses on this machine. */
export async function mcpFind(flags: JsonFlag, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const list = (await fetchMcpCandidates(opts)).match(identity, failOn);
    if (flags.json === true) {
        printJson(list);
        return;
    }
    console.log();
    if (list.candidates.length === 0) console.log("  No MCP servers in the configs of other harnesses.");
    for (const candidate of list.candidates) {
        const target = candidate.type === "stdio" ? [candidate.command ?? "", ...(candidate.args ?? [])].join(" ") : (candidate.url ?? "");
        console.log(`  ${candidate.name}  ${candidate.source}  ${candidate.type}  ${target}`);
        console.log(`    ${candidate.sourcePath}`);
        const keys = [...candidate.envKeys, ...candidate.headerKeys];
        if (keys.length > 0) console.log(`    values to store as credentials: ${keys.join(", ")}`);
        if (candidate.conflict !== undefined) console.log(`    ! ${candidate.conflict}`);
    }
    console.log();
}

/** `inflexa mcp import <source-path> <name>`: copy a server of a different harness, each value as a stored credential. */
export async function mcpImport(sourcePath: string, name: string, flags: { as?: string }, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const server = (await importMcpServer({ sourcePath: resolve(sourcePath), name, as: flags.as }, opts)).match(identity, failOn);
    console.log(MCP_REPEAT_WARNING);
    console.log(`Added the MCP server "${server.name}". Its values are stored credentials.`);
}

function printRegistryServer(server: RegistryServerView): void {
    console.log(`  ${server.name}  ${server.version}${server.title === undefined ? "" : `  ${server.title}`}`);
    if (server.description.length > 0) console.log(`    ${server.description}`);
    for (const install of server.installs) {
        const inputs = install.inputs.map((input) => `${input.name}${input.secret ? " (secret)" : ""}${input.required ? "" : "?"}`);
        console.log(`    [${install.id}] ${install.kind}  ${install.label}${inputs.length === 0 ? "" : `  needs: ${inputs.join(", ")}`}`);
    }
}

/** `inflexa mcp search <text>`: the servers of the official MCP Registry whose name or description holds the text. */
export async function mcpSearch(text: string, flags: JsonFlag, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const page = (await searchMcpRegistry(text, undefined, opts)).match(identity, failOn);
    if (flags.json === true) {
        printJson(page);
        return;
    }
    console.log();
    if (page.servers.length === 0) console.log("  No servers.");
    for (const server of page.servers) printRegistryServer(server);
    console.log();
}

/** The flags of `inflexa mcp install`. */
export type McpInstallFlags = { as?: string; option?: string; input?: string[] };

/**
 * `inflexa mcp install <registry-name>`: add a server of the MCP Registry. A person at a terminal types each secret in
 * a masked prompt. With no terminal, for example from the chat agent, a secret stays empty, and
 * `inflexa credential set` gives it later.
 */
export async function mcpInstall(registryName: string, flags: McpInstallFlags, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const page = (await searchMcpRegistry(registryName, undefined, opts)).match(identity, failOn);
    const server = page.servers.find((candidate) => candidate.name === registryName) ?? fail(`No server "${registryName}" in the MCP Registry.`);
    const optionId = flags.option === undefined ? server.installs[0]?.id : Number(flags.option);
    const install =
        server.installs.find((candidate) => candidate.id === optionId) ?? fail(`The server "${registryName}" has no install option ${flags.option ?? ""}.`);
    const inputs: Record<string, string> = Object.fromEntries((flags.input ?? []).map((text) => keyValue("--input", text)));
    for (const input of install.inputs) {
        if (input.secret && inputs[input.name] === undefined && process.stdin.isTTY)
            inputs[input.name] = await promptSecret(`${input.name}${input.description === undefined ? "" : ` (${input.description})`}`);
    }
    const name = flags.as ?? registryName.slice(registryName.lastIndexOf("/") + 1).toLowerCase();
    const added = (await installMcpServer({ registryName, version: server.version, install: install.id, name, inputs }, opts)).match(identity, failOn);
    console.log(MCP_REPEAT_WARNING);
    console.log(`Added the MCP server "${added.name}" from the MCP Registry.`);
}
