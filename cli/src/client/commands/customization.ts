import { resolve } from "node:path";

import {
    ATTACHMENT_KINDS,
    type AgentDetail,
    type AgentView,
    type AttachmentKind,
    type AttachmentsView,
    type McpEntryView,
    type McpRevocationView,
    type McpServerView,
    type PutCredentialRequest,
    type SkillList,
} from "../../api/customization.ts";
import { fail } from "../../lib/cli.ts";
import { describeClientError, DEFAULT_CLIENT_OPTS, type ClientError, type ClientOpts } from "../api.ts";
import {
    addMcpServer,
    cloneAgent,
    deleteAgent,
    deleteMcpServer,
    fetchAgent,
    fetchAgents,
    fetchConnectors,
    fetchCredentials,
    fetchMcpServers,
    fetchSkills,
    findSkills,
    importAgent,
    importSkill,
    patchAgent,
    patchConnector,
    patchMcpServer,
    putCredential,
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
    console.log(`\n  ${agent.id}  (${agentKindLabel(agent)}, ${agent.role}, ${agent.enabled ? "on" : "off"})`);
    if (agent.description.length > 0) console.log(`  ${agent.description}`);
    if (agent.path !== undefined) console.log(`  file: ${agent.path}`);
    printAttachments("attachments:", agent.attachments);
    if (agent.change !== undefined) {
        printAttachments("added by you:", agent.change.add);
        printAttachments("removed by you:", agent.change.remove);
    }
    printGaps(agent, "  ");
    console.log();
}

/** `inflexa agent ls`: the built-in agents, the custom agents, and the drafts with their gaps. */
export async function agentLs(flags: JsonFlag, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const { agents } = (await fetchAgents(opts)).match(identity, failOn);
    if (flags.json === true) {
        printJson({ agents });
        return;
    }
    const width = Math.max(...agents.map((agent) => agent.id.length));
    console.log();
    for (const agent of agents) {
        console.log(
            `  ${agent.id.padEnd(width)}  ${agentKindLabel(agent).padEnd(8)}  ${agent.role.padEnd(11)}  ${agent.enabled ? "on " : "off"}  ${agent.description}`,
        );
        printGaps(agent, `  ${" ".repeat(width)}  `);
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

/** `inflexa agent clone <id> <new-id>`: copy a built-in executor into a new agent file. */
export async function agentClone(id: string, newId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const agent = (await cloneAgent(id, newId, opts)).match(identity, failOn);
    console.log(`Cloned "${id}" to ${agent.path ?? agent.id}. Edit the file to change the prompt.`);
}

/** `inflexa agent import <file>`: convert the agent file of another harness. A file with gaps is kept as a draft. */
export async function agentImport(file: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const agent = (await importAgent(resolve(file), opts)).match(identity, failOn);
    console.log(`Imported "${agent.id}" to ${agent.path ?? agent.id}.`);
    if (agent.draft) {
        console.log("The agent is a draft until you correct these gaps in the file:");
        printGaps(agent, "  ");
    }
}

/** `inflexa agent enable <id>` and `inflexa agent disable <id>`. */
export async function agentSetEnabled(id: string, enabled: boolean, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    (await patchAgent(id, { enabled }, opts)).match(identity, failOn);
    console.log(`The agent "${id}" is ${enabled ? "on" : "off"}.`);
}

/** `inflexa agent attach <id> <kind> <name>` and `inflexa agent detach <id> <kind> <name>`. */
export async function agentAttach(id: string, kind: string, name: string, attach: boolean, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const change = { kind: attachmentKindOf(kind), name };
    const agent = (await patchAgent(id, attach ? { attach: change } : { detach: change }, opts)).match(identity, failOn);
    console.log(attach ? `Attached the ${kind} "${name}" to "${id}".` : `Detached the ${kind} "${name}" from "${id}".`);
    printGaps(agent, "  ");
}

/** `inflexa agent rm <id>`: delete a custom agent file. */
export async function agentRm(id: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    (await deleteAgent(id, opts)).match(identity, failOn);
    console.log(`Removed the agent "${id}".`);
}

function printSkills(list: SkillList): void {
    const width = Math.max(0, ...list.skills.map((skill) => skill.name.length));
    console.log();
    if (list.skills.length === 0) console.log("  No skills.");
    for (const skill of list.skills) {
        console.log(`  ${skill.name.padEnd(width)}  ${skill.kind.padEnd(8)}  ${skill.directory}`);
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

/** `inflexa skill find <dir>`: the skills in a directory that the user names. */
export async function skillFind(dir: string, flags: JsonFlag, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const list = (await findSkills(resolve(dir), opts)).match(identity, failOn);
    if (flags.json === true) {
        printJson(list);
        return;
    }
    printSkills(list);
}

/** `inflexa skill import <dir>`: copy a skill directory into the custom skills. */
export async function skillImport(dir: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const skill = (await importSkill(resolve(dir), opts)).match(identity, failOn);
    console.log(`Imported the skill "${skill.name}" to ${skill.directory}.`);
}

/** `inflexa connector ls`: each connector, its settings, and whether each credential gives a value. */
export async function connectorLs(flags: JsonFlag, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const { connectors } = (await fetchConnectors(opts)).match(identity, failOn);
    if (flags.json === true) {
        printJson({ connectors });
        return;
    }
    const width = Math.max(...connectors.map((connector) => connector.id.length));
    console.log();
    for (const connector of connectors) {
        console.log(`  ${connector.id.padEnd(width)}  ${connector.enabled ? "on " : "off"}  ${connector.description}`);
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
export type ConnectorSetFlags = { enable?: boolean; disable?: boolean; endpoint?: string; credential?: string[] };

/** `inflexa connector set <id>`: turn a connector on or off, point it at an endpoint, and name its credentials. */
export async function connectorSet(id: string, flags: ConnectorSetFlags, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    if (flags.enable === true && flags.disable === true) fail("Give --enable or --disable, not both.");
    const credentials = Object.fromEntries((flags.credential ?? []).map((text) => keyValue("--credential", text)));
    const enabled = flags.enable === true ? true : flags.disable === true ? false : undefined;
    const body = { enabled, endpoint: flags.endpoint, credentials: Object.keys(credentials).length === 0 ? undefined : credentials };
    const connector = (await patchConnector(id, body, opts)).match(identity, failOn);
    console.log(`The connector "${connector.id}" is ${connector.enabled ? "on" : "off"}.`);
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
        const from = credential.source.kind === "env" ? `env ${credential.source.var}` : `command ${credential.source.command}`;
        console.log(`  ${credential.name}  ${from}  (${credential.resolves ? "gives a value" : "gives no value"})`);
    }
    console.log();
}

/** The flags of `inflexa credential set`. */
export type CredentialSetFlags = { env?: string; command?: string; format?: string; ttlMs?: string };

/** `inflexa credential set <name>`: declare an environment variable or a helper command as the source of a credential. */
export async function credentialSet(name: string, flags: CredentialSetFlags, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    if ((flags.env === undefined) === (flags.command === undefined)) fail("Give --env <VAR> or --command <command>, and only one.");
    let source: PutCredentialRequest;
    if (flags.env !== undefined) {
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
export async function mcpSetEnabled(name: string, enabled: boolean, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    (await patchMcpServer(name, enabled, opts)).match(identity, failOn);
    console.log(`The MCP server "${name}" is ${enabled ? "on" : "off"}.`);
}

/** `inflexa mcp rm <name>`: remove an MCP server, its tokens, and its client registration. */
export async function mcpRm(name: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    (await deleteMcpServer(name, opts)).match(identity, failOn);
    console.log(`Removed the MCP server "${name}".`);
}

/** `inflexa mcp auth <name>`: sign in to an MCP server in the browser. */
export async function mcpAuth(name: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    console.log(`A browser opens for the sign-in to "${name}". The command waits up to 5 minutes for you to finish.`);
    (await signInMcpServer(name, opts)).match(identity, failOn);
    console.log(`Signed in to "${name}".`);
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
