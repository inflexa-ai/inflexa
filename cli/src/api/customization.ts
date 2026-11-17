// The wire types of the customization routes: agents, skills, connectors, credentials, and MCP servers.

/** The three kinds of thing that a user attaches to an agent. */
export const ATTACHMENT_KINDS = ["connector", "mcp", "skill"] as const;

/** One kind of attachment: a connector, an MCP server, or a skill. */
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** The connectors, the MCP servers, and the skills of an agent. */
export type AttachmentsView = {
    connectors: string[];
    mcp: string[];
    skills: string[];
};

/** Why an agent, or one of its references, does not resolve. */
export type AgentGapView = {
    /** A stable code, for example `unknown_skill` or `invalid_yaml`. */
    reason: string;
    /** The reference that did not resolve, when the gap names one. */
    reference?: string;
    /** One line for a person. */
    message: string;
};

/** One agent of the list: a built-in agent, a custom agent, or a draft. */
export type AgentView = {
    id: string;
    name: string;
    kind: "builtin" | "custom";
    /** True for a custom agent file that does not resolve. A draft never reaches the harness. */
    draft: boolean;
    role: string;
    description: string;
    enabled: boolean;
    /** False for a built-in agent that must stay on. */
    canDisable: boolean;
    /** True for the agent that fills its role now. Each enabled executor is active, because a plan chooses among them. */
    active: boolean;
    /** The attachments that the agent gets: the defaults with the change of the user, or the lists of the file. */
    attachments: AttachmentsView;
    /** The release defaults of a built-in agent. Absent for a custom agent. */
    defaults?: AttachmentsView;
    /** The change of the user to a built-in agent, as a difference from the defaults. Absent for a custom agent. */
    change?: { add: AttachmentsView; remove: AttachmentsView };
    /** The file of a custom agent or a draft. */
    path?: string;
    gaps: AgentGapView[];
};

/**
 * One agent with its prompt body: the part that a custom agent of the role can change. The harness adds the parts that
 * each agent of the role shares. `prompt` is `null` for a draft with no body.
 */
export type AgentDetail = AgentView & {
    prompt: string | null;
};

/** A role that one agent fills at a time, and the agent that fills it. */
export type RoleView = {
    role: string;
    /** The agent that fills the role now. `null` when the role is off, for example an analogy agent that the user turned off. */
    activeAgentId: string | null;
    /** The agent that the user chose. Absent when the role keeps its built-in agent. */
    chosenAgentId?: string;
    builtinAgentId: string;
    gaps: AgentGapView[];
};

/** The body of `GET /api/v1/catalog/agents`: the built-in agents first, then each custom agent and draft, and the roles. */
export type AgentList = {
    agents: AgentView[];
    roles: RoleView[];
};

/** The body of `PUT /api/v1/catalog/roles/:role`. The built-in agent of the role clears the choice. */
export type ChooseRoleAgentRequest = {
    agentId: string;
};

/** The body of `POST /api/v1/catalog/agents/:id/clone`. */
export type CloneAgentRequest = {
    newId: string;
    /** The description of the new agent. Absent: the description of the source. */
    description?: string;
};

/** The body of `POST /api/v1/catalog/agents/import`. The path is absolute, on the machine of the server. */
export type ImportAgentRequest = {
    path: string;
    /** The role of the new agent. Absent: `executor`. */
    role?: string;
};

/** One agent file in the agent directory of another harness. */
export type FoundAgentView = {
    /** The id that an import gives the agent. */
    id: string;
    description: string;
    /** The harness of the directory, for example `Claude Code`. */
    source: string;
    path: string;
    /** The reason that an import refuses the file, for example an id that an agent already has. */
    conflict?: string;
};

/** An agent file that does not convert. */
export type FoundAgentProblemView = {
    path: string;
    message: string;
};

/** The body of `GET /api/v1/catalog/agents/found`. */
export type FoundAgentList = {
    agents: FoundAgentView[];
    problems: FoundAgentProblemView[];
};

/** One attachment that a `PATCH` adds or removes. */
export type AttachmentChange = {
    kind: AttachmentKind;
    name: string;
};

/**
 * The body of `PATCH /api/v1/catalog/agents/:id`. Each field is optional, and the server applies `enabled`, then
 * `description` and `prompt`, then `attach`, then `detach`. A body with a `description` or a `prompt` for a built-in agent
 * is refused, because a built-in agent is read-only.
 */
export type PatchAgentRequest = {
    enabled?: boolean;
    attach?: AttachmentChange;
    detach?: AttachmentChange;
    /** The description of a custom agent. The planner reads the description of an executor to assign the steps. */
    description?: string;
    /** The prompt body of a custom agent. */
    prompt?: string;
};

/** The body of a `DELETE /api/v1/catalog/agents/:id` response. */
export type DeleteAgentResponse = {
    deleted: true;
};

/** One skill: a built-in skill, a custom skill, or a skill that `skill find` found in a directory. */
export type SkillView = {
    name: string;
    /** When the agent reads the skill. It opens with "Read before you". */
    description: string;
    /** The first heading of the skill, for a person. */
    title?: string;
    /** The group of the skill: `metadata.category`. */
    category?: string;
    tags: string[];
    kind: "builtin" | "custom" | "found";
    directory: string;
    /** For a found skill: the reason that an import refuses it, for example a name that a skill already has. */
    conflict?: string;
};

/** The body of `GET /api/v1/skills/:name`: one skill with the text of its `SKILL.md` and the paths of its other files. */
export type SkillDetail = SkillView & {
    body: string;
    files: string[];
};

/** A skill directory that is not a skill, or a custom skill that the store leaves out. */
export type SkillProblemView = {
    directory: string;
    kind: "builtin" | "custom" | "found";
    message: string;
};

/** The body of `GET /api/v1/skills`, of `GET /api/v1/skills?dir=<dir>`, and of `GET /api/v1/skills/found`. */
export type SkillList = {
    skills: SkillView[];
    problems: SkillProblemView[];
};

/** The body of `POST /api/v1/skills/import`. The path is absolute, on the machine of the server. */
export type ImportSkillRequest = {
    path: string;
};

/** One credential slot of a connector, and the credential that fills it. */
export type ConnectorSlotView = {
    slot: string;
    required: boolean;
    /** The source inside the tool that the slot opens, when the tool queries more than one source. */
    unlocks?: string;
    /** The credential name that the slot reads. A slot with no setting reads the credential of the same name. */
    credential: string;
    /** True when the credential gives a value now. The value itself never crosses the wire. */
    resolves: boolean;
};

/** One connector of the registry, with the settings of the user. */
export type ConnectorView = {
    id: string;
    /** The group of the connector, for example `literature` or `chemistry-and-drugs`. */
    category: string;
    description: string;
    /** The endpoint override of the user. */
    endpoint?: string;
    defaultEndpoint?: string;
    slots: ConnectorSlotView[];
};

/** The body of `GET /api/v1/connectors`. */
export type ConnectorList = {
    connectors: ConnectorView[];
};

/**
 * The body of `PATCH /api/v1/connectors/:id`. `endpoint: null` restores the default endpoint. A slot set to `null`
 * reads the credential of the same name again.
 */
export type PatchConnectorRequest = {
    endpoint?: string | null;
    credentials?: Record<string, string | null>;
};

/**
 * Where the value of a credential comes from. The config never holds the value. A `stored` value is in the macOS
 * Keychain, or in a `0600` file, and it never crosses the wire after it is set.
 */
export type CredentialSourceView =
    { kind: "env"; var: string } | { kind: "command"; command: string; format?: "raw" | "exec-credential"; ttlMs?: number } | { kind: "stored" };

/** One credential of the config: its source and whether it gives a value now, or the reason that it does not parse. */
export type CredentialView = { name: string; source: CredentialSourceView; resolves: boolean } | { name: string; problem: string };

/** The body of `GET /api/v1/credentials`. */
export type CredentialList = {
    credentials: CredentialView[];
};

/** The body of `PUT /api/v1/credentials/:name`: the source of the credential. */
/**
 * The body of `PUT /api/v1/credentials/:name`. A `stored` credential carries its value one time, here. The server
 * keeps the value out of the config, and no read gives it back.
 */
export type PutCredentialRequest =
    { kind: "env"; var: string } | { kind: "command"; command: string; format?: "raw" | "exec-credential"; ttlMs?: number } | { kind: "stored"; value: string };

/** The body of a `DELETE /api/v1/credentials/:name` response. The stored value goes too. */
export type DeleteCredentialResponse = {
    deleted: true;
};

/** An MCP server entry, as the config holds it. A secret in `env` or `headers` is a `${cred:<name>}` reference. */
export type McpEntryView =
    | {
          type: "stdio";
          command: string;
          args: string[];
          env: Record<string, string>;
          approval: "always" | "never";
          scriptable: boolean;
          enabled: boolean;
      }
    | {
          type: "http";
          url: string;
          headers: Record<string, string>;
          auth?: "oauth";
          approval: "always" | "never";
          scriptable: boolean;
          enabled: boolean;
      };

/** One MCP server of the config, valid or with the reason that it is not. */
export type McpServerView =
    | {
          name: string;
          entry: McpEntryView;
          /** For an HTTP server with OAuth: true when the token store holds tokens for its URL. */
          signedIn?: boolean;
      }
    | { name: string; problem: string };

/** The body of `GET /api/v1/mcp`. */
export type McpServerList = {
    servers: McpServerView[];
};

/**
 * The body of `POST /api/v1/mcp`. The server validates `entry` against the MCP entry schema of the config and fills
 * its defaults.
 */
export type AddMcpServerRequest = {
    name: string;
    entry: unknown;
};

/** The body of `PATCH /api/v1/mcp/:name`. */
export type PatchMcpServerRequest = {
    enabled: boolean;
};

/** The body of a `DELETE /api/v1/mcp/:name` response. */
export type DeleteMcpServerResponse = {
    deleted: true;
};

/** The body of a `POST /api/v1/mcp/:name/auth` response: the sign-in completed. */
export type McpAuthResponse = {
    signedIn: true;
};

/** What the authorization server did with the tokens: revoked them, or got no request because it has no revocation endpoint or the server held no tokens. */
export type McpRevocationView = { status: "revoked" | "no_endpoint" | "not_signed_in" } | { status: "failed"; reason: string };

/** The body of a `DELETE /api/v1/mcp/:name/auth` response: no token of the server remains. */
export type McpLogoutResponse = {
    signedIn: false;
    revocation: McpRevocationView;
};

/** An MCP server that the config of a different harness defines, for an import. The values of `env` and `headers` never cross the wire. */
export type McpCandidateView = {
    /** The name of the server in the other config. */
    name: string;
    /** The harness that holds it, for example "Claude Code" or "Cursor". */
    source: string;
    /** The config file that holds it. An import names this path. */
    sourcePath: string;
    type: "stdio" | "http";
    command?: string;
    args?: string[];
    url?: string;
    /** The variables of a local server. An import stores each value as a credential. */
    envKeys: string[];
    /** The headers of an HTTP server. An import stores each value as a credential. */
    headerKeys: string[];
    /** The reason that an import under the same name refuses it, for example a name that the config has already. */
    conflict?: string;
};

/** The body of `GET /api/v1/mcp/found`: the MCP servers in the configs of other harnesses on this machine. */
export type McpCandidateList = {
    candidates: McpCandidateView[];
};

/**
 * The body of `POST /api/v1/mcp/import`. The server copies the entry of the other config, stores each value of `env`
 * and `headers` as a credential, and puts a `${cred:<name>}` reference in its place.
 */
export type ImportMcpServerRequest = {
    sourcePath: string;
    name: string;
    /** The name in this config. Absent: the name of the other config. */
    as?: string;
};

/** One value that a server of the MCP Registry asks for when it is added. */
export type RegistryInputView = {
    /** The name of the variable, or of the header. */
    name: string;
    kind: "env" | "header";
    description?: string;
    required: boolean;
    /** A secret value goes to a stored credential, never into the config. */
    secret: boolean;
    default?: string;
};

/** One way to run a server of the MCP Registry: a package that a local command runs, or a remote URL. */
export type RegistryInstallView = {
    /** The index of the option in the entry of the registry. An install names it. */
    id: number;
    kind: "npm" | "pypi" | "oci" | "remote";
    /** What runs, for a person: for example `npx -y @scope/server@1.2.0` or the URL. */
    label: string;
    inputs: RegistryInputView[];
};

/** One server of the MCP Registry. */
export type RegistryServerView = {
    /** The name in the registry, for example `io.github.owner/server`. */
    name: string;
    title?: string;
    description: string;
    version: string;
    repository?: string;
    installs: RegistryInstallView[];
};

/** The body of `GET /api/v1/mcp/registry?search=<text>`: a page of the official MCP Registry. */
export type RegistryServerList = {
    servers: RegistryServerView[];
    nextCursor?: string;
};

/**
 * The body of `POST /api/v1/mcp/install`. The server reads the entry of the registry again, builds the config entry
 * of the chosen option, stores each secret input as a credential, and puts each other input in the entry.
 */
export type InstallMcpServerRequest = {
    registryName: string;
    version: string;
    install: number;
    /** The name in this config. */
    name: string;
    inputs: Record<string, string>;
};
