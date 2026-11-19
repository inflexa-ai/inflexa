import type { JSX } from "solid-js";

import type { AgentDetail, AgentList, AgentView, ConnectorView, CredentialView, McpServerView, SkillList } from "../api/customization.ts";
import { describeClientError, DEFAULT_CLIENT_OPTS, type ClientError, type ClientOpts } from "../client/api.ts";
import {
    deleteCredential,
    fetchAgent,
    fetchAgents,
    fetchConnectors,
    fetchCredentials,
    fetchMcpServers,
    fetchSkill,
    fetchSkillFile,
    fetchSkills,
    patchConnector,
    putCredential,
} from "../client/customization.ts";
import { GLYPHS } from "../lib/design_system.ts";
import type { Command } from "./commands.tsx";
import { ConfirmDialog } from "./components/dialog/confirm_dialog.tsx";
import { PromptDialog } from "./components/dialog/prompt_dialog.tsx";
import { ResultsDialog } from "./components/dialog/results_dialog.tsx";
import { SelectDialog } from "./components/dialog/select_dialog.tsx";
import type { SelectItem } from "./components/list_core.tsx";
import type { Workspace } from "./contexts/workspace.ts";
import { notify } from "./hooks/notice.ts";

// The Customize group of the palette. The terminal shows what is set up and edits only the connectors and the
// credentials. The chat agent and Flamme do the other changes, because a terminal dialog has no room for an editor.

/** One line for a person: the message of a server error body, else the description of the client error. */
function errorText(e: ClientError): string {
    return e.type === "http" ? e.body.message : describeClientError(e);
}

function notifyError(e: ClientError): void {
    notify({ kind: "error", text: errorText(e) });
}

/** The newest first, by an ISO 8601 time. An item with no time goes last. */
function byNewest<T extends { readonly modifiedAt?: string | undefined }>(a: T, b: T): number {
    return (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? "");
}

function shortTime(iso: string | undefined): string | undefined {
    return iso === undefined ? undefined : new Date(iso).toLocaleString();
}

/** The header of each role in the list of the agents, in the order of the list. */
const ROLE_GROUPS: readonly { readonly role: string; readonly label: string }[] = [
    { role: "chat", label: "Chat" },
    { role: "planner", label: "Planner" },
    { role: "executor", label: "Executors" },
    { role: "profiler", label: "Profiler" },
    { role: "synthesizer", label: "Synthesizer" },
    { role: "analogy", label: "Analogy" },
    { role: "reporter", label: "Reporter" },
];

type AgentState = { readonly draft: boolean; readonly enabled: boolean; readonly active: boolean };

/** The state word of an agent. An agent that is on but not chosen fills no role: a role takes one agent. */
function stateOf(agent: AgentState): string {
    if (agent.draft) return "draft";
    if (!agent.enabled) return "off";
    return agent.active ? "active" : "not chosen";
}

/** The mark before the name: the agent works now, does not work now, or does not resolve. */
function agentMark(agent: AgentState): string {
    if (agent.draft) return "!";
    return agent.active ? GLYPHS.circle : GLYPHS.circleHollow;
}

function countText(count: number, noun: string): string {
    return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The agents of the list, under one header for each role. In a role, the active agents come first, then the custom
 * agents, the newest first, then the built-in agents. A mark and a hint give the state of each row.
 */
export function agentItems(list: AgentList): SelectItem<string>[] {
    const rank = (agent: AgentView): number => (agent.active ? 0 : agent.kind === "custom" ? 1 : 2);
    const known = new Set(ROLE_GROUPS.map((group) => group.role));
    const groups = [...ROLE_GROUPS, ...[...new Set(list.agents.map((agent) => agent.role))].filter((role) => !known.has(role)).map((role) => ({ role, label: role }))];
    return groups.flatMap(({ role, label }) =>
        list.agents
            .filter((agent) => agent.role === role)
            .sort((a, b) => rank(a) - rank(b) || byNewest(a, b))
            .map((agent): SelectItem<string> => {
                const hint = [
                    stateOf(agent),
                    ...(agent.kind === "custom" ? ["custom"] : []),
                    ...(agent.gaps.length > 0 ? [countText(agent.gaps.length, "gap")] : []),
                ].join(` ${GLYPHS.middot} `);
                const changed = shortTime(agent.modifiedAt);
                const { connectors, mcp, skills } = agent.attachments;
                const description = [
                    agent.description,
                    `${countText(skills.length, "skill")}, ${countText(connectors.length, "connector")}, ${countText(mcp.length, "MCP server")}`,
                    ...(changed === undefined ? [] : [`changed ${changed}`]),
                ].join(` ${GLYPHS.middot} `);
                const item: SelectItem<string> = { value: agent.id, title: agent.id, prefix: agentMark(agent), hint, description, category: role, categoryLabel: label };
                return agent.draft ? { ...item, tone: "warning" } : item;
            }),
    );
}

function listLine(label: string, items: readonly string[]): string {
    return `  ${label}: ${items.length === 0 ? "none" : items.join(", ")}`;
}

/** The read-only view of one agent: its state, its attachments, its gaps, and its prompt. */
export function agentDetailLines(agent: AgentDetail): string[] {
    const lines = [
        `${agent.name}  (${agent.kind === "builtin" ? "built-in" : "custom"}, ${agent.role}, ${stateOf(agent)})`,
        agent.description,
        ...(agent.path === undefined ? [] : [`File: ${agent.path}`]),
        "",
        "Attachments",
        listLine("connectors", agent.attachments.connectors),
        listLine("MCP servers", agent.attachments.mcp),
        listLine("skills", agent.attachments.skills),
    ];
    if (agent.gaps.length > 0) lines.push("", "Gaps", ...agent.gaps.map((gap) => `  - ${gap.message}`));
    lines.push("", "Prompt", ...(agent.prompt ?? "(no prompt)").split("\n"));
    return lines;
}

/** A skill row, or a custom skill folder that the store leaves out, with its problem. */
export type SkillChoice = { readonly kind: "skill"; readonly name: string } | { readonly kind: "problem"; readonly directory: string; readonly message: string };

/** The active agents that attach each skill, by skill name. An agent that is off or not chosen uses no skill. */
export function skillUsers(agents: AgentList): ReadonlyMap<string, readonly string[]> {
    const users = new Map<string, string[]>();
    for (const agent of agents.agents) {
        if (!agent.active) continue;
        for (const skill of agent.attachments.skills) users.set(skill, [...(users.get(skill) ?? []), agent.id]);
    }
    return users;
}

/** The most agent names that a hint gives before it counts the rest. */
const USED_BY_NAMES = 2;

/** The agents that use a skill, for a hint, or `not attached`. */
export function usedByText(users: readonly string[] | undefined): string {
    if (users === undefined || users.length === 0) return "not attached";
    const rest = users.length - USED_BY_NAMES;
    return `used by ${users.slice(0, USED_BY_NAMES).join(", ")}${rest > 0 ? ` +${String(rest)}` : ""}`;
}

/**
 * The skills of the list, under the headers Custom, Built-in and Not loaded. The custom skills come newest first. With
 * the agents, a mark and a hint say which active agents use each skill.
 */
export function skillItems(list: SkillList, agents: AgentList | undefined): SelectItem<SkillChoice>[] {
    const users = agents === undefined ? undefined : skillUsers(agents);
    const custom = list.skills.filter((skill) => skill.kind === "custom").sort(byNewest);
    const builtin = list.skills.filter((skill) => skill.kind !== "custom");
    const skills = [...custom, ...builtin].map((skill): SelectItem<SkillChoice> => {
        const isCustom = skill.kind === "custom";
        const changed = isCustom ? shortTime(skill.modifiedAt) : undefined;
        const description = [skill.title ?? skill.description, ...(changed === undefined ? [] : [`changed ${changed}`])].join(` ${GLYPHS.middot} `);
        const item: SelectItem<SkillChoice> = {
            value: { kind: "skill", name: skill.name },
            title: skill.name,
            description,
            category: isCustom ? "custom" : "builtin",
            categoryLabel: isCustom ? "Custom" : "Built-in",
        };
        if (users === undefined) return item;
        const used = users.get(skill.name);
        return { ...item, prefix: used === undefined ? GLYPHS.circleHollow : GLYPHS.circle, hint: usedByText(used) };
    });
    const problems = list.problems.map(
        (problem): SelectItem<SkillChoice> => ({
            value: { kind: "problem", directory: problem.directory, message: problem.message },
            title: problem.directory,
            description: problem.message,
            category: "problem",
            categoryLabel: "Not loaded",
            prefix: users === undefined ? undefined : "!",
            hint: "not loaded",
            tone: "warning",
        }),
    );
    return [...skills, ...problems];
}

/** The read-only view of the MCP servers: the entry, the sign-in state, and the last failed start of each one. */
export function mcpLines(servers: readonly McpServerView[]): string[] {
    return servers.flatMap((server): string[] => {
        if ("problem" in server) return [`${server.name}  (not correct)`, `  ${server.problem}`, ""];
        const { entry } = server;
        const target = entry.type === "stdio" ? [entry.command, ...entry.args].join(" ") : entry.url;
        const lines = [`${server.name}  (${entry.type}, ${entry.enabled ? "on" : "off"}, approval ${entry.approval})`, `  ${target}`];
        if (server.signedIn !== undefined) lines.push(`  ${server.signedIn ? "signed in" : "not signed in"}`);
        if (server.startFailure !== undefined) lines.push(`  did not start at ${shortTime(server.startFailure.at) ?? ""}: ${server.startFailure.reason}`);
        return [...lines, ""];
    });
}

/** What a connector menu edits: the endpoint, or the credential of one slot. */
export type ConnectorChoice = { readonly kind: "endpoint" } | { readonly kind: "slot"; readonly slot: string };

/** The menu of one connector: its endpoint, then one row for each credential slot. */
export function connectorMenuItems(connector: ConnectorView): SelectItem<ConnectorChoice>[] {
    const endpoint = connector.endpoint ?? connector.defaultEndpoint;
    return [
        {
            value: { kind: "endpoint" },
            title: "Endpoint",
            description: `${endpoint ?? "none"}${connector.endpoint === undefined ? " (default)" : ""}`,
        },
        ...connector.slots.map(
            (slot): SelectItem<ConnectorChoice> => ({
                value: { kind: "slot", slot: slot.slot },
                title: `Credential: ${slot.slot}`,
                description: [slot.credential, slot.resolves ? "gives a value" : "no value", slot.required ? "required" : "optional"].join(` ${GLYPHS.middot} `),
            }),
        ),
    ];
}

function credentialSourceText(credential: CredentialView): string {
    if ("problem" in credential) return `not correct ${GLYPHS.middot} ${credential.problem}`;
    const { source } = credential;
    const from = source.kind === "env" ? `env ${source.var}` : source.kind === "command" ? `command ${source.command}` : "stored value";
    return `${from} ${GLYPHS.middot} ${credential.resolves ? "gives a value" : "no value"}`;
}

/** A credential row, or the row that adds a credential. */
export type CredentialChoice = { readonly kind: "credential"; readonly name: string } | { readonly kind: "add" };

export function credentialItems(credentials: readonly CredentialView[]): SelectItem<CredentialChoice>[] {
    return [
        ...credentials.map(
            (credential): SelectItem<CredentialChoice> => ({
                value: { kind: "credential", name: credential.name },
                title: credential.name,
                description: credentialSourceText(credential),
            }),
        ),
        { value: { kind: "add" }, title: `Add a credential${GLYPHS.ellipsis}`, pinned: true },
    ];
}

type CredentialAction = "env" | "command" | "remove";

/** The menu of one credential. A stored value needs an input that hides the text, which this dialog does not have. */
function credentialActionItems(exists: boolean): SelectItem<CredentialAction>[] {
    return [
        { value: "env", title: "Read from an environment variable" },
        { value: "command", title: "Read from the output of a command" },
        ...(exists ? [{ value: "remove" as const, title: "Remove" }] : []),
    ];
}

/** Open the list of the agents. A row opens the read-only view of the agent over the list. */
export async function openAgents(ws: Workspace, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const list = await fetchAgents(opts);
    if (list.isErr()) {
        notifyError(list.error);
        return;
    }
    ws.openDialog(() => (
        <SelectDialog
            title="Agents"
            placeholder={`Search agents${GLYPHS.ellipsis}`}
            items={agentItems(list.value)}
            emptyText="No agents"
            onCancel={() => ws.closeDialog()}
            onSelect={(id: string) => {
                void fetchAgent(id, opts).match(
                    (agent) => ws.openDialog(() => <ResultsDialog title={agent.id} lines={agentDetailLines(agent)} emptyText="" onClose={() => ws.closeDialog()} />),
                    notifyError,
                );
            }}
        />
    ));
}

/** Open the list of the skills. A skill opens the list of its files, and a file opens its text. */
export async function openSkills(ws: Workspace, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    // The skills stay readable when the agents do not load: the rows then give no mark and no hint.
    const agentsPending = fetchAgents(opts).match(
        (value): AgentList | undefined => value,
        () => undefined,
    );
    const list = await fetchSkills(opts);
    const agentList = await agentsPending;
    const users = agentList === undefined ? undefined : skillUsers(agentList);
    if (list.isErr()) {
        notifyError(list.error);
        return;
    }
    ws.openDialog(() => (
        <SelectDialog
            title="Skills"
            placeholder={`Search skills${GLYPHS.ellipsis}`}
            items={skillItems(list.value, agentList)}
            emptyText="No skills"
            onCancel={() => ws.closeDialog()}
            onSelect={(choice: SkillChoice) => {
                if (choice.kind === "problem") {
                    ws.openDialog(() => <ResultsDialog title={choice.directory} lines={[choice.message]} emptyText="" onClose={() => ws.closeDialog()} />);
                    return;
                }
                void openSkillFiles(ws, choice.name, users === undefined ? undefined : usedByText(users.get(choice.name)), opts);
            }}
        />
    ));
}

async function openSkillFiles(ws: Workspace, name: string, usedBy: string | undefined, opts: ClientOpts): Promise<void> {
    const skill = await fetchSkill(name, opts);
    if (skill.isErr()) {
        notifyError(skill.error);
        return;
    }
    const files = ["SKILL.md", ...skill.value.files];
    ws.openDialog(() => (
        <SelectDialog
            title={[name, skill.value.kind === "custom" ? "custom" : "built-in", ...(usedBy === undefined ? [] : [usedBy])].join(` ${GLYPHS.middot} `)}
            placeholder={`Search files${GLYPHS.ellipsis}`}
            items={files.map((path) => ({ value: path, title: path }))}
            emptyText="No files"
            onCancel={() => ws.closeDialog()}
            onSelect={(path: string) => {
                void fetchSkillFile(name, path, opts).match(
                    (file) =>
                        ws.openDialog(() => (
                            <ResultsDialog title={`${name}/${path}`} lines={file.content.split("\n")} emptyText="(empty file)" onClose={() => ws.closeDialog()} />
                        )),
                    notifyError,
                );
            }}
        />
    ));
}

/** Open the read-only view of the MCP servers. */
export async function openMcpServers(ws: Workspace, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const servers = await fetchMcpServers(opts);
    if (servers.isErr()) {
        notifyError(servers.error);
        return;
    }
    const lines = mcpLines(servers.value.servers);
    ws.openDialog(() => <ResultsDialog title="MCP servers" lines={lines} emptyText="No MCP servers" onClose={() => ws.closeDialog()} />);
}

/** Open the list of the connectors. A connector opens its menu, which edits the endpoint or the credential of a slot. */
export async function openConnectors(ws: Workspace, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const list = await fetchConnectors(opts);
    if (list.isErr()) {
        notifyError(list.error);
        return;
    }
    ws.openDialog(() => (
        <SelectDialog
            title="Connectors"
            placeholder={`Search connectors${GLYPHS.ellipsis}`}
            items={list.value.connectors.map((connector) => ({ value: connector.id, title: connector.id, description: connector.category }))}
            emptyText="No connectors"
            onCancel={() => ws.closeDialog()}
            onSelect={(id: string) => {
                const connector = list.value.connectors.find((candidate) => candidate.id === id);
                if (connector !== undefined) openConnectorMenu(ws, connector, opts);
            }}
        />
    ));
}

/** The menu of one connector, over the list of the connectors. Each edit reopens the menu with the new state. */
function openConnectorMenu(ws: Workspace, connector: ConnectorView, opts: ClientOpts): void {
    const reopen = (updated: ConnectorView): void => {
        ws.closeDialog();
        openConnectorMenu(ws, updated, opts);
    };
    ws.openDialog(() => (
        <SelectDialog
            title={connector.id}
            items={connectorMenuItems(connector)}
            emptyText=""
            onCancel={() => ws.closeDialog()}
            onSelect={(choice: ConnectorChoice) => {
                if (choice.kind === "endpoint") ws.openDialog(() => endpointPrompt(ws, connector, opts, reopen));
                else void openSlotCredentials(ws, connector, choice.slot, opts, reopen);
            }}
        />
    ));
}

/** The prompt for the endpoint of a connector. Empty text restores the default endpoint. */
function endpointPrompt(ws: Workspace, connector: ConnectorView, opts: ClientOpts, onSaved: (connector: ConnectorView) => void): JSX.Element {
    return (
        <PromptDialog
            title={`Endpoint of ${connector.id}`}
            value={connector.endpoint ?? ""}
            placeholder={connector.defaultEndpoint ?? "An endpoint URL"}
            description={() => <text>Leave the field empty to use the default endpoint.</text>}
            onCancel={() => ws.closeDialog()}
            onSubmit={(raw) => {
                ws.closeDialog();
                const endpoint = raw.trim();
                void patchConnector(connector.id, { endpoint: endpoint.length === 0 ? null : endpoint }, opts).match((updated) => {
                    notify({ kind: "info", text: `Changed the endpoint of ${updated.id}.` });
                    onSaved(updated);
                }, notifyError);
            }}
        />
    );
}

/** The value that makes a slot read the credential of its own name again. */
const SLOT_DEFAULT = "";

async function openSlotCredentials(
    ws: Workspace,
    connector: ConnectorView,
    slot: string,
    opts: ClientOpts,
    onSaved: (connector: ConnectorView) => void,
): Promise<void> {
    const credentials = await fetchCredentials(opts);
    if (credentials.isErr()) {
        notifyError(credentials.error);
        return;
    }
    const items: SelectItem<string>[] = [
        { value: SLOT_DEFAULT, title: `The credential "${slot}"`, description: "the default of the slot", pinned: true },
        ...credentials.value.credentials.map((credential) => ({ value: credential.name, title: credential.name, description: credentialSourceText(credential) })),
    ];
    ws.openDialog(() => (
        <SelectDialog
            title={`${connector.id}: ${slot}`}
            placeholder={`Search credentials${GLYPHS.ellipsis}`}
            items={items}
            emptyText="No credentials"
            onCancel={() => ws.closeDialog()}
            onSelect={(name: string) => {
                ws.closeDialog();
                void patchConnector(connector.id, { credentials: { [slot]: name === SLOT_DEFAULT ? null : name } }, opts).match((updated) => {
                    notify({ kind: "info", text: `The slot ${slot} of ${updated.id} reads the credential "${name === SLOT_DEFAULT ? slot : name}".` });
                    onSaved(updated);
                }, notifyError);
            }}
        />
    ));
}

/** Open the list of the credentials. A credential opens its menu, and the last row adds a credential. */
export async function openCredentials(ws: Workspace, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const list = await fetchCredentials(opts);
    if (list.isErr()) {
        notifyError(list.error);
        return;
    }
    const names = new Set(list.value.credentials.map((credential) => credential.name));
    // Each change closes the list and opens it again, thus the list shows the new state.
    const refresh = (): void => {
        ws.closeDialog();
        void openCredentials(ws, opts);
    };
    ws.openDialog(() => (
        <SelectDialog
            title="Credentials"
            placeholder={`Search credentials${GLYPHS.ellipsis}`}
            items={credentialItems(list.value.credentials)}
            emptyText="No credentials"
            footerHint="a stored value: inflexa credential set <name>"
            onCancel={() => ws.closeDialog()}
            onSelect={(choice: CredentialChoice) => {
                if (choice.kind === "credential") openCredentialMenu(ws, choice.name, true, opts, refresh);
                else
                    ws.openDialog(() => (
                        <PromptDialog
                            title="New credential"
                            placeholder="A name: lowercase letters, digits, hyphens, underscores"
                            validate={(raw) => (names.has(raw.trim()) ? `The credential "${raw.trim()}" exists already.` : raw.trim().length === 0 ? "A name is required." : undefined)}
                            onCancel={() => ws.closeDialog()}
                            onSubmit={(raw) => {
                                ws.closeDialog();
                                openCredentialMenu(ws, raw.trim(), false, opts, refresh);
                            }}
                        />
                    ));
            }}
        />
    ));
}

function openCredentialMenu(ws: Workspace, name: string, exists: boolean, opts: ClientOpts, refresh: () => void): void {
    ws.openDialog(() => (
        <SelectDialog
            title={name}
            items={credentialActionItems(exists)}
            emptyText=""
            onCancel={() => ws.closeDialog()}
            onSelect={(action: CredentialAction) => {
                ws.closeDialog();
                if (action === "remove") {
                    ws.openDialog(() => (
                        <ConfirmDialog
                            title={`Remove ${name}`}
                            message={`Remove the credential "${name}" and its stored value? A connector or an MCP server that reads it stops getting a value.`}
                            tone="danger"
                            confirmLabel="remove"
                            onCancel={() => ws.closeDialog()}
                            onConfirm={() => {
                                ws.closeDialog();
                                void deleteCredential(name, opts).match(() => {
                                    notify({ kind: "info", text: `Removed the credential "${name}".` });
                                    refresh();
                                }, notifyError);
                            }}
                        />
                    ));
                    return;
                }
                ws.openDialog(() => (
                    <PromptDialog
                        title={action === "env" ? `${name}: environment variable` : `${name}: command`}
                        placeholder={action === "env" ? "For example NCBI_API_KEY" : "For example op read op://lab/ncbi"}
                        validate={(raw) => (raw.trim().length === 0 ? "A value is required." : undefined)}
                        onCancel={() => ws.closeDialog()}
                        onSubmit={(raw) => {
                            ws.closeDialog();
                            const value = raw.trim();
                            void putCredential(name, action === "env" ? { kind: "env", var: value } : { kind: "command", command: value }, opts).match((credential) => {
                                notify({ kind: "info", text: `Set the credential "${credential.name}".` });
                                refresh();
                            }, notifyError);
                        }}
                    />
                ));
            }}
        />
    ));
}

/** The commands of the Customize group of the palette. */
export const customizeCommands: Command[] = [
    {
        id: "customize.agents",
        title: "Agents",
        description: "Show the built-in and the custom agents, the newest custom agent first",
        category: "Customize",
        run: (ws) => openAgents(ws),
    },
    {
        id: "customize.skills",
        title: "Skills",
        description: "Show the built-in and the custom skills, and read each file of a skill",
        category: "Customize",
        run: (ws) => openSkills(ws),
    },
    {
        id: "customize.mcp",
        title: "MCP servers",
        description: "Show the MCP servers, their state, and the last failed start",
        category: "Customize",
        run: (ws) => openMcpServers(ws),
    },
    {
        id: "customize.connectors",
        title: "Connectors",
        description: "Set the endpoint and the credential of each connector",
        category: "Customize",
        run: (ws) => openConnectors(ws),
    },
    {
        id: "customize.credentials",
        title: "Credentials",
        description: "Add, change, or remove the credentials that connectors and MCP servers read",
        category: "Customize",
        run: (ws) => openCredentials(ws),
    },
];
