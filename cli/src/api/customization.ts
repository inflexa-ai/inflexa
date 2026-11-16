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

/** One agent with its prompt. `prompt` is `null` for a role that composes its own prompt, or a draft with no body. */
export type AgentDetail = AgentView & {
    prompt: string | null;
};

/** The body of `GET /api/v1/agents`: the built-in agents first, then each custom agent and draft. */
export type AgentList = {
    agents: AgentView[];
};

/** The body of `POST /api/v1/agents/:id/clone`. */
export type CloneAgentRequest = {
    newId: string;
};

/** The body of `POST /api/v1/agents/import`. The path is absolute, on the machine of the server. */
export type ImportAgentRequest = {
    path: string;
};

/** One attachment that a `PATCH` adds or removes. */
export type AttachmentChange = {
    kind: AttachmentKind;
    name: string;
};

/**
 * The body of `PATCH /api/v1/agents/:id`. Each field is optional, and the server applies `enabled`, then `attach`,
 * then `detach`. A body with a `prompt` for a built-in agent is refused, because a built-in prompt is read-only.
 */
export type PatchAgentRequest = {
    enabled?: boolean;
    attach?: AttachmentChange;
    detach?: AttachmentChange;
};

/** The body of a `DELETE /api/v1/agents/:id` response. */
export type DeleteAgentResponse = {
    deleted: true;
};

/** One skill: a built-in skill, a custom skill, or a skill that `skill find` found in a directory. */
export type SkillView = {
    name: string;
    description: string;
    kind: "builtin" | "custom" | "found";
    directory: string;
    /** For a found skill: the reason that an import refuses it, for example a name that a skill already has. */
    conflict?: string;
};

/** A skill directory that is not a skill, or a custom skill that the store leaves out. */
export type SkillProblemView = {
    directory: string;
    kind: "builtin" | "custom" | "found";
    message: string;
};

/** The body of `GET /api/v1/skills`, and of `GET /api/v1/skills?dir=<dir>`. */
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
    description: string;
    enabled: boolean;
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
    enabled?: boolean;
    endpoint?: string | null;
    credentials?: Record<string, string | null>;
};

/** Where the value of a credential comes from. The config never holds the value. */
export type CredentialSourceView = { kind: "env"; var: string } | { kind: "command"; command: string; format?: "raw" | "exec-credential"; ttlMs?: number };

/** One credential of the config: its source and whether it gives a value now, or the reason that it does not parse. */
export type CredentialView = { name: string; source: CredentialSourceView; resolves: boolean } | { name: string; problem: string };

/** The body of `GET /api/v1/credentials`. */
export type CredentialList = {
    credentials: CredentialView[];
};

/** The body of `PUT /api/v1/credentials/:name`: the source of the credential. */
export type PutCredentialRequest = CredentialSourceView;

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

/** The body of a `DELETE /api/v1/mcp/:name/auth` response: no token of the server remains. */
/** What the authorization server did with the tokens: revoked them, or got no request because it has no revocation endpoint or the server held no tokens. */
export type McpRevocationView = { status: "revoked" | "no_endpoint" | "not_signed_in" } | { status: "failed"; reason: string };

export type McpLogoutResponse = {
    signedIn: false;
    revocation: McpRevocationView;
};
