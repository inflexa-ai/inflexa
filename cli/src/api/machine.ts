import type { AGENT_EFFORTS, Config } from "../lib/config.ts";
import type { ContainerRuntimeId } from "../lib/container.ts";

/** One agent role of the runtime. The same closed set as `models.agents` of the config. */
export type AgentName = "conversation" | "sandbox" | "utility";

/** A reasoning effort an agent can run at: one rung of `AGENT_EFFORTS`. */
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

/** What one agent runs: its model and its reasoning effort. */
export type AgentSelection = {
    model: string;
    effort: AgentEffort;
};

/** One agent of `GET /api/v1/agents`. */
export type AgentView = {
    role: AgentName;
    /** The selection that the live runtime runs now, or `null` until the runtime boots. */
    current: AgentSelection | null;
    /** A saved selection that waits for the agent work in flight to settle, or `null`. */
    pending: AgentSelection | null;
};

/** The body of `GET /api/v1/agents`, in the order of the agent set. */
export type AgentList = {
    agents: AgentView[];
};

/** The body of `PUT /api/v1/agents/:role`. The server validates the model against the connection first. */
export type PutAgentRequest = AgentSelection;

/** The body of `PUT /api/v1/agents/:role`: the agent after the save, and if the switch applied now or waits for idle. */
export type PutAgentResponse = {
    agent: AgentView;
    status: "applied" | "scheduled";
};

/** One model of the connection, with the efforts that it takes. */
export type ListedModelView = {
    id: string;
    efforts: AgentEffort[];
};

/** The body of `GET /api/v1/models`. A listing that failed is `models: null`, and the client offers a free-text id. */
export type ModelList = {
    models: ListedModelView[] | null;
};

/** The body of `GET /api/v1/me`: the identity of the stored session of the server user. */
export type MeView =
    | {
          signedIn: true;
          name?: string;
          email?: string;
          /** The `sub` claim of the ID token. */
          subject?: string;
          /** False when the stored ID token does not decode. The session still exists. */
          claimsDecoded: boolean;
          /** When the access token expires, as ISO 8601. An expired token renews at the next use. */
          expiresAt: string;
      }
    | {
          signedIn: false;
          /** Why no identity is available, with the remedy. */
          error: string;
      };

/**
 * The resolved Postgres connection of the server. Each field has a value: an unset field shows its default.
 * The password never leaves the server.
 */
export type PostgresSettings = {
    host: string;
    port: number;
    database: string;
    user: string;
    /** Whether the config holds a password. When it holds none, the connection uses the default password. */
    passwordSet: boolean;
};

/** The embedding backend of the config: the `embedding` key whole, with no api key. The api key never leaves the server. */
export type EmbeddingSettings = Omit<Config["embedding"], "apiKey"> & {
    /** Whether the config holds an api key. */
    apiKeySet: boolean;
};

/** The server keys of the config that a client can change. The client keys (`theme`, `keybinds`, `leaderTimeout`) stay in the client. */
export type ServerSettingsValues = {
    telemetry: boolean;
    /** The container runtime, or `null` until the first command that needs one picks a ready runtime. */
    runtime: ContainerRuntimeId | null;
    postgres: PostgresSettings;
    embedding: EmbeddingSettings;
};

/** The Postgres connection of a {@link SettingsPatch}. */
export type PostgresSettingsPatch = Omit<PostgresSettings, "passwordSet"> & {
    /** A new password. When absent, the config keeps the password that it holds. */
    password?: string;
};

/** The embedding block of a {@link SettingsPatch}. An `api-key` block with no `apiKey` keeps the api key that the config holds. */
export type EmbeddingSettingsPatch = Config["embedding"];

/** The defaults that the embedding choices of a settings screen fill in. */
export type EmbeddingDefaults = {
    /** The base URL of an `api-key` backend that names none. */
    apiBaseUrl: string;
    /** The vector width of an `api-key` backend that names none. */
    apiDimensions: number;
    /** The vector width of the built-in local model. */
    localDimensions: number;
    /** The path of the built-in local model on the server machine. */
    builtinModelPath: string;
};

/** The body of `GET` and `PATCH /api/v1/settings`. A change applies at the next boot of the runtime. */
export type ServerSettings = ServerSettingsValues & {
    embeddingDefaults: EmbeddingDefaults;
};

/** The body of `PATCH /api/v1/settings`: the keys to replace. An `embedding` value replaces the block whole. */
export type SettingsPatch = Partial<
    Omit<ServerSettingsValues, "postgres" | "embedding"> & { postgres: PostgresSettingsPatch; embedding: EmbeddingSettingsPatch }
>;

/** The request header that carries the api key of `GET /api/v1/embedding-models`. A key in the query string would land in each log of the URL. */
export const EMBEDDING_API_KEY_HEADER = "Inflexa-Embedding-Api-Key";

/** The body of `GET /api/v1/embedding-models`: the ids of the endpoint, or why the listing failed. */
export type EmbeddingModelList = { models: string[] } | { models: null; reason: string };
