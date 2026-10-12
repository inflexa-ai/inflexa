/** The version of the HTTP API. It is also the `v1` segment of each path. */
export const API_VERSION = 1;

/** The phase of the harness runtime boot inside the server. A route that needs the runtime gives 503 `unavailable` until `ready`. */
export type ServerPhase = "starting" | "ready" | "failed";

/**
 * The {@link ServerBootError} reason of a provider login that is absent or dead. The boot cannot ask for a login,
 * thus `inflexa up` in a terminal signs in, then sends `POST /api/v1/server/boot`.
 */
export const SIGN_IN_REQUIRED = "sign_in_required";

/** Why the boot failed: one actionable message, and the detail lines of the cause. */
export type ServerBootError = {
    /**
     * A stable code: the `type` of the harness boot error, {@link SIGN_IN_REQUIRED}, or `infra_unready` for the
     * other faults of the containers, the proxy, and the embedder.
     */
    reason: string;
    /** The remedy, for a person. */
    message: string;
    detailLines: string[];
};

/** The model connection that the runtime booted on. */
export type ServerConnection = {
    /** The configured vendor slug (`anthropic`, `openai`, …). */
    provider: string;
    /** `cliproxy` is the owned local proxy. `direct` is an endpoint that the user configured. */
    mode: "cliproxy" | "direct";
    /** The model of the conversation agent at boot. A later model switch does not change it. */
    model: string;
};

/** The fields of {@link ServerState} that do not change with the phase. */
export type ServerIdentity = {
    /** The version of the inflexa package that runs the server. */
    version: string;
    /** A server of a different build can send a different value, thus a client compares it with its own {@link API_VERSION}. */
    apiVersion: number;
    /** When the server process started, as ISO 8601. */
    startedAt: string;
};

/**
 * A step of the boot, in the boot order. `proxy` and `credential` run only in `cliproxy` mode. Each step
 * ends when the next one starts.
 */
export type BootStepId = "container_engine" | "proxy" | "images" | "containers" | "credential" | "embedder" | "runtime";

/** The bytes that the pull of the missing images moved. */
export type BootPullProgress = {
    /** The sum of the moved bytes over the images that the pull moves now. */
    doneBytes: number;
    /** The sum of the image sizes from the registry manifests, or `null` when a size is not known. */
    totalBytes: number | null;
};

/** The step that runs now. Only the step `images` can carry the byte progress of its pull. */
export type BootStepRunning =
    | {
          /** Every step except `images`, which has its own variant because only it carries `progress`. */
          id: Exclude<BootStepId, "images">;
          /** When the step started, as ISO 8601. */
          startedAt: string;
      }
    | {
          /** The pull of the missing container images. */
          id: "images";
          /** When the step started, as ISO 8601. */
          startedAt: string;
          /** Absent until the pull reports bytes. A boot that pulls with `compose pull` never gives it. */
          progress?: BootPullProgress;
      };

/** A step of the attempt that ended. */
export type BootStepDone = {
    /** The step that ended. */
    id: BootStepId;
    /** When the step started, as ISO 8601. */
    startedAt: string;
    /** When the step ended, as ISO 8601. */
    endedAt: string;
};

/** The progress of the boot attempt that runs now. */
export type BootProgress = {
    /** When the attempt started, as ISO 8601. */
    attemptStartedAt: string;
    /** The step that runs now, or `null` before the first step starts. */
    step: BootStepRunning | null;
    /** Each step of the attempt that ended, in the boot order. */
    done: BootStepDone[];
};

/** The part of {@link ServerState} that the boot holder owns: the phase of the boot, and its progress. */
export type ServerBootState = ServerIdentity &
    (
        | {
              /** The boot runs: the first attempt, or a new one after `failed`. */
              phase: "starting";
              /** The progress of the attempt that runs now. */
              boot: BootProgress;
          }
        | {
              /** The runtime booted. */
              phase: "ready";
              /** The model connection that the runtime booted on. */
              connection: ServerConnection;
          }
        | {
              /** The last attempt failed. A new `POST /api/v1/server/boot` starts another. */
              phase: "failed";
              /** Why the attempt failed, with the remedy. */
              bootError: ServerBootError;
              /** When the failed attempt started, as ISO 8601. */
              attemptStartedAt: string;
              /** When the attempt failed, as ISO 8601. */
              failedAt: string;
              /** The step that ran at the fault, or `null` for a fault before the first step. */
              failedStep: BootStepId | null;
          }
    );

/** The body of `GET /api/v1/server`. */
export type ServerState = ServerBootState & {
    /** The mode of a stop in progress, kept until the process exits, or `null` while no client asked for a stop. */
    stopping: ShutdownMode | null;
};

/** The `details` of the 503 `unavailable` body of a route that needs the runtime. */
export type RuntimeUnavailableDetails = {
    /** The boot phase that makes the runtime unavailable: `starting` or `failed`. */
    phase: ServerPhase;
    /** The step that runs now (`starting`), the step that failed (`failed`), or `null`. */
    step: BootStepId | null;
};

/** The build channel of a server. A dev server and a production server use different ports and files. */
export type ServerChannel = "development" | "production";

/**
 * The discovery file of a running server (`<dataDir>/inflexa/server.json`, `server.dev.json` in the dev
 * channel). The server writes it with mode 0600 after it binds its port, and removes it at its stop. A client
 * reads it to find the server and its bearer token.
 */
export type ServerDiscovery = {
    pid: number;
    port: number;
    /** The bearer token that each request under `/api/` must send. */
    token: string;
    version: string;
    apiVersion: number;
    /** When the server process started, as ISO 8601. */
    startedAt: string;
    channel: ServerChannel;
};

/** How long a `drain` stop waits for the running chat turns before it aborts them. */
export const SHUTDOWN_DRAIN_LIMIT_MS = 60_000;

/**
 * How `POST /api/v1/server/shutdown` stops the server. `now` aborts each running chat turn at once. `drain`
 * waits up to 60 s for the running chat turns, then aborts the rest. A run is a durable workflow in both
 * modes: it continues at the next start of a server.
 */
export type ShutdownMode = "now" | "drain";

/** The body of `POST /api/v1/server/shutdown`. */
export type ShutdownRequest = {
    mode: ShutdownMode;
};

/** The 202 body of `POST /api/v1/server/shutdown`. A second request while a stop runs gives the mode of the first. */
export type ShutdownAccepted = {
    mode: ShutdownMode;
    /** The chat turns that ran when the stop started. */
    activeTurns: number;
};

/** The durable work of the server, from the run ledger and the profile ledger. */
export type DurableWork =
    /** Each run and data profile whose workflow is live. */
    | { state: "counted"; runs: number; profiles: number }
    /** The runtime is not ready, thus no workflow runs in this server. */
    | { state: "no_runtime" }
    /** The ledger read failed: the count is not known. */
    | { state: "unreadable" };

/** The body of `GET /api/v1/server/activity`: the work that a stop of the server interrupts. */
export type ServerActivity = {
    /** The mode of the stop in progress, or `null` while the server runs. */
    stopping: ShutdownMode | null;
    /** The chat turns that run now. */
    turns: number;
    /** The analyses whose inputs a profile drive stages now, before its workflow starts. */
    profileDrives: number;
    durable: DurableWork;
};
