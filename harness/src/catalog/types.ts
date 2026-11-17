/**
 * The agent catalog: the input through which a host gives the harness its agents, skills, connectors, MCP servers
 * and credentials. The harness owns these types and never reads a file or a database of the host.
 */

import type { OAuthClientProvider } from "@modelcontextprotocol/client";

export type AgentRole = "chat" | "planner" | "executor" | "profiler" | "synthesizer" | "analogy" | "reporter";

/** A role that one agent fills at a time. The executors are many, and a plan chooses one for each step. */
export type SingleAgentRole = Exclude<AgentRole, "executor">;

/** The agent that the host chose for a role, by id. A role with no choice takes its built-in agent. */
export type RoleAssignments = Readonly<Partial<Record<SingleAgentRole, string>>>;

export type BuiltinAgentId = "inflexa" | "planner" | "analyst" | "drug-analyst" | "data-profiler" | "synthesizer" | "analogy" | "reporter";

/** What a user attaches to an agent. A user attaches connectors and MCP servers, never single tools. */
export type AgentAttachments = {
    readonly connectors: readonly string[];
    readonly mcp: readonly string[];
    readonly skills: readonly string[];
};

/** A custom agent. A user can make only an executor. */
export type CustomAgent = AgentAttachments & {
    readonly id: string;
    readonly name: string;
    readonly role: AgentRole;
    readonly description: string;
    readonly prompt: string;
};

/**
 * One entry of a catalog. A built-in entry holds only the changes of the user, because the release owns the base of a
 * built-in agent. A custom entry holds the whole agent.
 */
export type AgentEntry =
    | {
          readonly kind: "builtin";
          readonly id: BuiltinAgentId;
          readonly enabled: boolean;
          readonly add: Partial<AgentAttachments>;
          readonly remove: Partial<AgentAttachments>;
      }
    | { readonly kind: "custom"; readonly enabled: boolean; readonly definition: CustomAgent };

export type McpTransportConfig =
    | { readonly kind: "stdio"; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> }
    | { readonly kind: "http"; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly auth?: OAuthClientProvider };

/** An MCP server, with each credential reference already resolved by the host. */
export type McpServerConfig = {
    readonly name: string;
    readonly transport: McpTransportConfig;
    /** `always` sends each call through the tool-approval gate. */
    readonly approval: "always" | "never";
    /** A scriptable server also gives its tools to `run_script`. It needs `approval: "never"`. */
    readonly scriptable: boolean;
};

/** The settings of one connector. A connector with no settings is enabled, at its default endpoint. */
export type ConnectorSettings = {
    readonly id: string;
    readonly enabled: boolean;
    readonly endpoint?: string;
    /** The credential name of each slot. A slot with no name reads the credential of the same name. */
    readonly credentials?: Readonly<Record<string, string>>;
};

export type SkillInfo = {
    readonly name: string;
    /** When to read the skill. The agent reads it, thus it opens with "Read before you". */
    readonly description: string;
    /** The first heading of the body, for a list that a person reads. */
    readonly title?: string;
    /** The group of the skill in a list for a person: `metadata.category`. */
    readonly category?: string;
    /** `metadata.tags`. */
    readonly tags?: readonly string[];
};

/** A reader of skill files. The harness never takes a skills directory. */
export type SkillStore = {
    readonly list: () => Promise<readonly SkillInfo[]>;
    /** The relative paths of the text files of a skill, with `/` separators. Empty for an unknown skill. */
    readonly files: (skill: string) => Promise<readonly string[]>;
    /** The text of one file of a skill, or `undefined` when the skill or the file does not exist. */
    readonly read: (skill: string, path: string) => Promise<string | undefined>;
    /** The size of one file in bytes, or `undefined` when it does not exist. */
    readonly size: (skill: string, path: string) => Promise<number | undefined>;
};

export type AgentCatalog = {
    readonly agents: () => Promise<readonly AgentEntry[]>;
    readonly skills: SkillStore;
    readonly mcpServers: () => Promise<readonly McpServerConfig[]>;
    readonly connectors: () => Promise<readonly ConnectorSettings[]>;
    readonly roles: () => Promise<RoleAssignments>;
    /** The value of a credential, or `undefined` when the host has none. */
    readonly credential: (name: string) => Promise<string | undefined>;
};

/** The identity of an agent that a workflow keeps in its input. */
export type AgentIdentity = {
    readonly id: string;
    readonly name: string;
    readonly role: AgentRole;
    readonly prompt: string;
    readonly promptHash: string;
};
