import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { err, errAsync, ok, okAsync, ResultAsync, type Result } from "neverthrow";
import { z } from "zod";

import type { McpCandidateView, RegistryInputView, RegistryInstallView, RegistryServerList, RegistryServerView } from "../../api/customization.ts";
import { messageOf } from "../../lib/cause.ts";
import { unknownRecordSchema } from "../../lib/json_record.ts";

// The sources of an MCP server entry outside this config: the configs of other harnesses on this machine, and the
// official MCP Registry. An entry from a source carries values, and a value can be a secret, thus the values stay in
// this module and the service. The wire gives the keys only.

/** One harness config file that can hold MCP servers, and the key of its server map. */
type ConfigSource = { readonly source: string; readonly path: string; readonly key: "mcpServers" | "servers" };

/** The config files of other harnesses that hold MCP servers, on this platform. */
export function knownMcpConfigs(home: string = homedir(), platform: NodeJS.Platform = process.platform): readonly ConfigSource[] {
    const appSupport = platform === "darwin" ? join(home, "Library", "Application Support") : join(home, ".config");
    return [
        { source: "Claude Code", path: join(home, ".claude.json"), key: "mcpServers" },
        { source: "Claude Desktop", path: join(appSupport, "Claude", "claude_desktop_config.json"), key: "mcpServers" },
        { source: "Cursor", path: join(home, ".cursor", "mcp.json"), key: "mcpServers" },
        { source: "Windsurf", path: join(home, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" },
        { source: "VS Code", path: join(appSupport, "Code", "User", "mcp.json"), key: "servers" },
    ];
}

/** An MCP server entry of a different harness, with its values. The values never leave the server. */
export type FoundMcpServer = {
    readonly name: string;
    readonly source: string;
    readonly sourcePath: string;
    /** The project of a Claude Code entry that a project holds, by its folder. */
    readonly project?: string;
    readonly entry:
        | { readonly type: "stdio"; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> }
        | { readonly type: "http"; readonly url: string; readonly headers: Readonly<Record<string, string>> };
};

const stringMap = z.record(z.string(), z.string()).catch({});

/** The server entry forms of the harnesses: a command, or a URL under `url` or under `serverUrl` (Windsurf). */
const ForeignCommandSchema = z.object({ command: z.string().min(1), args: z.array(z.string()).catch([]).optional(), env: stringMap.optional() });
const ForeignUrlSchema = z.object({ url: z.string().min(1), headers: stringMap.optional() });
const ForeignServerUrlSchema = z.object({ serverUrl: z.string().min(1), headers: stringMap.optional() });

function foundEntryOf(raw: unknown): FoundMcpServer["entry"] | undefined {
    const command = ForeignCommandSchema.safeParse(raw);
    if (command.success) return { type: "stdio", command: command.data.command, args: command.data.args ?? [], env: command.data.env ?? {} };
    const url = ForeignUrlSchema.safeParse(raw);
    if (url.success) return { type: "http", url: url.data.url, headers: url.data.headers ?? {} };
    const serverUrl = ForeignServerUrlSchema.safeParse(raw);
    if (serverUrl.success) return { type: "http", url: serverUrl.data.serverUrl, headers: serverUrl.data.headers ?? {} };
    return undefined;
}

function serversOf(map: unknown, base: Omit<FoundMcpServer, "name" | "entry">): FoundMcpServer[] {
    const parsed = unknownRecordSchema.safeParse(map);
    if (!parsed.success) return [];
    return Object.entries(parsed.data).flatMap(([name, raw]) => {
        const entry = foundEntryOf(raw);
        return entry === undefined ? [] : [{ ...base, name, entry }];
    });
}

/** Read a JSON file as a record, or `undefined` when it is absent or does not parse. */
function readRecord(path: string): Record<string, unknown> | undefined {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
    return JSON.parseWith(text, unknownRecordSchema) ?? undefined;
}

/** The MCP servers of the configs of other harnesses. A file that is absent or does not parse gives none. */
export function findMcpServers(
    sources: readonly ConfigSource[] = knownMcpConfigs(),
    read: (path: string) => Record<string, unknown> | undefined = readRecord,
): FoundMcpServer[] {
    return sources.flatMap((config) => {
        const file = read(config.path);
        if (file === undefined) return [];
        const base = { source: config.source, sourcePath: config.path };
        const found = serversOf(file[config.key], base);
        // Claude Code keeps the servers of each project under `projects.<folder>.mcpServers`.
        const projects = config.source === "Claude Code" ? unknownRecordSchema.safeParse(file.projects) : undefined;
        if (projects?.success === true) {
            for (const [project, value] of Object.entries(projects.data)) {
                const record = unknownRecordSchema.safeParse(value);
                if (record.success) found.push(...serversOf(record.data.mcpServers, { ...base, project }));
            }
        }
        return found;
    });
}

/** The view of a found server: the keys of its values, never the values. */
export function candidateView(found: FoundMcpServer, conflict: string | undefined): McpCandidateView {
    const common = {
        name: found.name,
        source: found.project === undefined ? found.source : `${found.source} (${found.project})`,
        sourcePath: found.sourcePath,
    };
    const view: McpCandidateView =
        found.entry.type === "stdio"
            ? { ...common, type: "stdio", command: found.entry.command, args: [...found.entry.args], envKeys: Object.keys(found.entry.env), headerKeys: [] }
            : { ...common, type: "http", url: found.entry.url, envKeys: [], headerKeys: Object.keys(found.entry.headers) };
    if (conflict !== undefined) view.conflict = conflict;
    return view;
}

// ── The MCP Registry ────────────────────────────────────────────────

export const MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io";

/** How long a request to the registry can take. */
const REGISTRY_TIMEOUT_MS = 15_000;

const RegistryInputSchema = z.looseObject({
    name: z.string().min(1),
    description: z.string().optional(),
    isRequired: z.boolean().optional(),
    isSecret: z.boolean().optional(),
    default: z.string().optional(),
    value: z.string().optional(),
});

const RegistryArgumentSchema = z.looseObject({ type: z.string(), value: z.string().optional(), name: z.string().optional() });

const RegistryPackageSchema = z.looseObject({
    registryType: z.string(),
    identifier: z.string().min(1),
    version: z.string().optional(),
    transport: z.looseObject({ type: z.string() }).optional(),
    runtimeArguments: z.array(RegistryArgumentSchema).catch([]).optional(),
    packageArguments: z.array(RegistryArgumentSchema).catch([]).optional(),
    environmentVariables: z.array(RegistryInputSchema).catch([]).optional(),
});

const RegistryRemoteSchema = z.looseObject({
    type: z.string(),
    url: z.string().min(1),
    headers: z.array(RegistryInputSchema).catch([]).optional(),
});

const RegistryServerSchema = z.looseObject({
    name: z.string().min(1),
    title: z.string().optional(),
    description: z.string().catch(""),
    version: z.string().catch(""),
    repository: z.looseObject({ url: z.string().optional() }).optional(),
    packages: z.array(RegistryPackageSchema).catch([]).optional(),
    remotes: z.array(RegistryRemoteSchema).catch([]).optional(),
});

export type RegistryServer = z.infer<typeof RegistryServerSchema>;

const RegistryPageSchema = z.object({
    servers: z.array(z.looseObject({ server: RegistryServerSchema })),
    metadata: z.looseObject({ nextCursor: z.string().optional() }).optional(),
});

/** A way to run a registry server that this host can run, as the index of the registry entry gives it. */
type InstallOption =
    | { readonly id: number; readonly kind: "npm" | "pypi" | "oci"; readonly pkg: z.infer<typeof RegistryPackageSchema> }
    | { readonly id: number; readonly kind: "remote"; readonly remote: z.infer<typeof RegistryRemoteSchema> };

/**
 * The options of a registry server that this host runs: a stdio package of npm, PyPI, or an OCI image, and a remote
 * with the streamable HTTP transport. The ids number the packages first, then the remotes.
 */
function installOptions(server: RegistryServer): InstallOption[] {
    const options: InstallOption[] = [];
    const packages = server.packages ?? [];
    for (const [index, pkg] of packages.entries()) {
        const kind = pkg.registryType === "npm" || pkg.registryType === "pypi" || pkg.registryType === "oci" ? pkg.registryType : undefined;
        if (kind !== undefined && (pkg.transport?.type ?? "stdio") === "stdio") options.push({ id: index, kind, pkg });
    }
    for (const [index, remote] of (server.remotes ?? []).entries()) {
        if (remote.type === "streamable-http") options.push({ id: packages.length + index, kind: "remote", remote });
    }
    return options;
}

/** The fixed arguments of a package: the values that need no input. An argument that names a `{variable}` is left out. */
function fixedArguments(args: readonly z.infer<typeof RegistryArgumentSchema>[] | undefined): string[] {
    return (args ?? []).flatMap((arg) => {
        if (arg.value === undefined || arg.value.includes("{")) return [];
        return arg.type === "named" && arg.name !== undefined ? [arg.name, arg.value] : [arg.value];
    });
}

/** The command and the arguments that run a package. */
function commandOf(option: Extract<InstallOption, { kind: "npm" | "pypi" | "oci" }>, version: string): { command: string; args: string[] } {
    const { pkg } = option;
    const pinned = pkg.version ?? version;
    const runtime = fixedArguments(pkg.runtimeArguments);
    const after = fixedArguments(pkg.packageArguments);
    switch (option.kind) {
        case "npm":
            return { command: "npx", args: [...(runtime.includes("-y") ? runtime : ["-y", ...runtime]), `${pkg.identifier}@${pinned}`, ...after] };
        case "pypi":
            return { command: "uvx", args: [...runtime, `${pkg.identifier}==${pinned}`, ...after] };
        case "oci": {
            const image = pkg.identifier.includes(":") ? pkg.identifier : `${pkg.identifier}:${pinned}`;
            const passEnv = (pkg.environmentVariables ?? []).flatMap((variable) => ["-e", variable.name]);
            return { command: "docker", args: ["run", "-i", "--rm", ...passEnv, ...runtime, image, ...after] };
        }
        default: {
            const _exhaustive: never = option.kind;
            return _exhaustive;
        }
    }
}

function inputView(input: z.infer<typeof RegistryInputSchema>, kind: RegistryInputView["kind"]): RegistryInputView {
    const view: RegistryInputView = { name: input.name, kind, required: input.isRequired === true, secret: input.isSecret === true };
    if (input.description !== undefined) view.description = input.description;
    if (input.default !== undefined) view.default = input.default;
    return view;
}

function installView(option: InstallOption, version: string): RegistryInstallView {
    if (option.kind === "remote") {
        return { id: option.id, kind: "remote", label: option.remote.url, inputs: (option.remote.headers ?? []).map((header) => inputView(header, "header")) };
    }
    const { command, args } = commandOf(option, version);
    return {
        id: option.id,
        kind: option.kind,
        label: [command, ...args].join(" "),
        inputs: (option.pkg.environmentVariables ?? []).map((variable) => inputView(variable, "env")),
    };
}

function serverView(server: RegistryServer): RegistryServerView {
    const view: RegistryServerView = {
        name: server.name,
        description: server.description,
        version: server.version,
        installs: installOptions(server).map((option) => installView(option, server.version)),
    };
    if (server.title !== undefined) view.title = server.title;
    if (server.repository?.url !== undefined) view.repository = server.repository.url;
    return view;
}

/** Why a request to the registry failed. */
export type RegistryError = { readonly type: "registry_unavailable"; readonly detail: string };

export type RegistryOpts = {
    readonly baseUrl: string;
    readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
};

export const DEFAULT_REGISTRY_OPTS: RegistryOpts = { baseUrl: MCP_REGISTRY_URL, fetch: (input, init) => fetch(input, init) };

function getJson<T>(opts: RegistryOpts, path: string, schema: z.ZodType<T>): ResultAsync<T, RegistryError> {
    const unavailable = (detail: string): RegistryError => ({ type: "registry_unavailable", detail });
    return ResultAsync.fromPromise(
        opts.fetch(`${opts.baseUrl}${path}`, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS), headers: { accept: "application/json" } }),
        (cause) => unavailable(messageOf(cause)),
    )
        .andThen((response) => (response.ok ? okAsync(response) : errAsync(unavailable(`the registry answered ${response.status}`))))
        .andThen((response) => ResultAsync.fromPromise(response.text(), (cause) => unavailable(messageOf(cause))))
        .andThen((text) => {
            const parsed = JSON.parseWith(text, schema);
            return parsed === null ? errAsync(unavailable("the registry answered with an unknown form")) : okAsync(parsed);
        });
}

/** The latest version of each server of the registry whose name or description holds `search`, one page at a time. */
export function searchRegistry(
    search: string,
    cursor: string | undefined,
    opts: RegistryOpts = DEFAULT_REGISTRY_OPTS,
): ResultAsync<RegistryServerList, RegistryError> {
    const query = new URLSearchParams({ search, limit: "30", version: "latest" });
    if (cursor !== undefined) query.set("cursor", cursor);
    return getJson(opts, `/v0/servers?${query.toString()}`, RegistryPageSchema).map((page) => {
        const list: RegistryServerList = { servers: page.servers.map(({ server }) => serverView(server)) };
        const next = page.metadata?.nextCursor;
        if (next !== undefined) list.nextCursor = next;
        return list;
    });
}

const RegistryEntrySchema = z.looseObject({ server: RegistryServerSchema });

/** One version of one server of the registry. */
export function readRegistryServer(name: string, version: string, opts: RegistryOpts = DEFAULT_REGISTRY_OPTS): ResultAsync<RegistryServer, RegistryError> {
    return getJson(opts, `/v0/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`, RegistryEntrySchema).map((entry) => entry.server);
}

/** A value of an install that is a secret: the name of its credential and the value to store. */
export type SecretInput = { readonly credential: string; readonly value: string | undefined };

/** The config entry of an install, and the secrets that the entry references. */
export type InstallPlan = {
    readonly entry:
        { type: "stdio"; command: string; args: string[]; env: Record<string, string> } | { type: "http"; url: string; headers: Record<string, string> };
    readonly secrets: readonly SecretInput[];
};

/** Why an install cannot build its entry. */
export type InstallError = { readonly type: "unknown_install"; readonly id: number } | { readonly type: "missing_input"; readonly name: string };

/**
 * The config entry of option `id` of a registry server. A secret input becomes a `${cred:<name>}` reference, and its
 * value goes to the store of the caller. A required input with no value and no default refuses the install, except a
 * secret: the user can give its value later with `inflexa credential set`.
 */
export function planInstall(
    server: RegistryServer,
    id: number,
    inputs: Readonly<Record<string, string>>,
    credentialNameOf: (key: string) => string,
): Result<InstallPlan, InstallError> {
    const option = installOptions(server).find((candidate) => candidate.id === id);
    if (option === undefined) return err({ type: "unknown_install", id });
    const secrets: SecretInput[] = [];
    const values: Record<string, string> = {};
    const declared = option.kind === "remote" ? (option.remote.headers ?? []) : (option.pkg.environmentVariables ?? []);
    for (const input of declared) {
        const given = inputs[input.name] ?? input.default;
        if (input.isSecret === true) {
            const credential = credentialNameOf(input.name);
            secrets.push({ credential, value: inputs[input.name] });
            // A header value can be a template, for example "Bearer {api_key}". The secret fills the placeholder.
            const template = input.value;
            const open = template?.indexOf("{") ?? -1;
            const close = template?.indexOf("}", open) ?? -1;
            values[input.name] =
                template !== undefined && open !== -1 && close !== -1
                    ? `${template.slice(0, open)}\${cred:${credential}}${template.slice(close + 1)}`
                    : `\${cred:${credential}}`;
            continue;
        }
        if (given === undefined) {
            if (input.isRequired === true) return err({ type: "missing_input", name: input.name });
            continue;
        }
        values[input.name] = given;
    }
    if (option.kind === "remote") return ok({ entry: { type: "http", url: option.remote.url, headers: values }, secrets });
    return ok({ entry: { type: "stdio", ...commandOf(option, server.version), env: values }, secrets });
}
