/**
 * Sandbox-client types — the wire/persistence shapes that cross the
 * submit/poll protocol (see the harness-sandbox-exec spec) and the lease table.
 *
 * `SandboxRef` is the handle the harness uses to talk to a live sandbox. A lease
 * row persists the same shape (`PersistedSandboxRef`, from
 * `harness/state/schema.ts`).
 */

import type { ResultAsync } from "neverthrow";
import { z } from "zod";

import type { RunSession } from "../auth/types.js";
import type { ResourceSpec } from "../config/resource-limits.js";
import type { GateFailure } from "../lib/hooks.js";
import type { PackageQuery } from "./package-identity.js";
import type { PersistedSandboxRef } from "../state/schema.js";

export const SandboxBackend = z.enum(["docker", "k8s"]);
export type SandboxBackend = z.infer<typeof SandboxBackend>;

/**
 * The declared owner of the sandbox toolchain. `"image"` states that the
 * image owns the interpreters, conda, and Node. `"store"` states that the
 * mounted store owns them. An absent config field means `"store"`, thus an
 * old embedder keeps its environment and its prompt prefix. The harness keys
 * the resolver env and the orient-core prompt text on this declared value
 * only, and it never infers its host.
 */
export type ToolchainSource = "image" | "store";

/**
 * A resolved farm. `farmPath` is a host directory for the Docker backend,
 * and a PVC-relative path for the K8s backend. `cachePath` is the optional
 * per-analysis read-write cache. When it is present, the backend mounts it
 * at `/mnt/libs/cache`.
 */
export type FarmLocation = {
    readonly farmPath: string;
    readonly cachePath?: string;
};

/** The answer of a farm resolver: a usable farm, or a refusal that carries the reason of the embedder. */
export type FarmResolution = { readonly kind: "available"; readonly location: FarmLocation } | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Resolve the farm of one analysis. A backend calls this at each
 * `createSandbox`, thus a new farm reaches the next sandbox with no restart.
 *
 * The resolver carries the mount gate when the backend cannot. On a
 * volume-backed farm (K8s) the host cannot stat `farmPath`, thus the
 * resolver MUST answer `unavailable` when the `inflexa.lock` of the farm
 * does not parse. A backend with a host-readable path (Docker) proves the
 * lock itself, after the resolution.
 */
export type ResolveAnalysisFarm = (analysisId: string) => Promise<FarmResolution>;

/**
 * Where the farm of an analysis comes from. A required field of each sandbox
 * backend config — the harness never invents a farm location, and it reads
 * no store-root `current` pointer. `fixed` names one farm for every
 * analysis. `per-analysis` supplies a resolver.
 */
export type FarmSource = { readonly kind: "fixed"; readonly location: FarmLocation } | { readonly kind: "per-analysis"; readonly resolve: ResolveAnalysisFarm };

/**
 * One outcome per query, index-aligned with the query array.
 *
 * `spelling` echoes the spelling of its query verbatim, never a normalized
 * form. A caller quotes it into a remedy (`inflexa store add <spelling>`), and
 * an R name is case-sensitive with dots, thus a normalized echo would name a
 * package that no repository holds.
 *
 * - `linked` — the pool held the package, and this call linked it.
 * - `present` — the farm linked it already.
 * - `absent` — the pool does not hold it. `acquisitionPossible` states that
 *   the host can acquire that ecosystem, or that it cannot. `detail`, when
 *   the realization gives one, classifies the miss in host terms — in
 *   flight, failed with a recorded reason, or never requested — and the
 *   launch refusal renders it beside the name.
 * - `collision` — the query resolves to two store directories: two
 *   versions of one distribution, or one spelling that both tracks hold. The
 *   outcome is terminal for the query. `detail`, when the realization
 *   gives one, names the two pins and the packages that need each side —
 *   without it, a caller must guess which package pulls each pin, and a
 *   wrong guess sends it into store surgery. For one spelling in two tracks
 *   the detail names the two identity keys instead.
 * - `unavailable` — the link pass itself could not answer: an unreadable
 *   dependency graph, a locked farm. The reason says why. It says NOTHING
 *   about the presence of the package, and it must never render as an
 *   absence — a false absence sends a caller chasing packages the pool
 *   holds.
 */
export type PackageRequestOutcome =
    | { readonly kind: "linked"; readonly spelling: string; readonly version: string }
    | { readonly kind: "present"; readonly spelling: string; readonly version: string }
    | { readonly kind: "absent"; readonly spelling: string; readonly acquisitionPossible: boolean; readonly detail?: string }
    | { readonly kind: "collision"; readonly spelling: string; readonly storeDirs: readonly [string, string]; readonly detail?: string }
    | { readonly kind: "unavailable"; readonly spelling: string; readonly reason: string };

/**
 * The farm-extension seam. The realization of the embedder links host-staged
 * packages into the farm of the analysis. It never installs, downloads, or
 * acquires. A link is live in a sandbox that already runs, because the farm
 * rides a bind mount.
 *
 * The seam speaks the query of the `package-identity` capability, thus the
 * host resolves the identity and the harness never folds a name.
 *
 * A failure of one package is an outcome. An `err` means that the whole
 * call gave no answer, and the harness reads it as `unavailable` for each
 * query.
 */
export type ExtendAnalysisFarm = (analysisId: string, queries: readonly PackageQuery[]) => ResultAsync<readonly PackageRequestOutcome[], GateFailure>;

/** The source of a build session: a git repository (an optional ref names a commit, a tag, or a branch), or a folder of the host. */
export type BuildSource = { readonly kind: "git"; readonly url: string; readonly ref?: string } | { readonly kind: "folder"; readonly path: string };

/** The plan of one build: the hosts the session egress must hold in the build phase, the apt packages it installs, and the build strategy. */
export type BuildPlan = {
    readonly hosts: readonly string[];
    readonly aptPackages: readonly string[];
    readonly strategy: string;
};

/** A started build session. */
export type BuildSessionHandle = {
    readonly sessionId: string;
    /** The full commit sha the host resolved and cloned. Absent for a folder source. */
    readonly commit?: string;
    /** The root of the session's working copy of the source — the default working directory of each exec. */
    readonly workingDir: string;
    /** The fixed hosts of the source-build class — the dated Ubuntu snapshot host beside the index and pak hosts — which the session egress holds beside every host the plan names. The plan ask shows them with the plan's own hosts, because the user approves exactly what the wall will allow. */
    readonly classHosts?: readonly string[];
};

/** One command of a build session. */
export type BuildSessionCommand = {
    readonly command: string;
    /** Session id plus per-session sequence, minted by the tool: the chat path has no durable step to derive it from. */
    readonly execId: string;
    /** Runs as root. The default is the non-root user of the image. */
    readonly root?: boolean;
    /** The plan this command runs under. The realization restarts the session container under the plan's host list before the command runs. */
    readonly plan?: BuildPlan;
};

/** The outcome of one session exec. `exitCode` is null when the exec produced no exit (a launch failure of the exec channel). */
export type BuildExecResult = {
    readonly execId: string;
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
};

/** The outcome of one clean run: `committed` holds the qualified pin and the store directory the run wrote; `failed` keeps the session open. */
export type BuildCommitResult =
    { readonly kind: "committed"; readonly pin: string; readonly storeDir: string } | { readonly kind: "failed"; readonly reason: string };

/** The input of one commit: the build script, and the directory of the source tree that holds the R `DESCRIPTION` when it is not the root. */
export type BuildCommitRequest = {
    readonly script: string;
    /** A relative path inside the source tree, with no `..` segment. The clean run resolves the R dependencies from this directory. */
    readonly packageDir?: string;
};

/**
 * The build-session interface of the embedder, behind the `install_from_source`
 * conversation tool. The embedder owns the container the build runs in, the
 * egress wall around it, and every store write — the harness drives the session
 * call by call and writes none of these itself. `start` carries the analysis
 * id of the conversation session the tool serves, and the commit extends the
 * farm of that analysis.
 *
 * `start` begins an exploration phase: the source is cloned at the resolved
 * commit (or the folder is copied in) before the first command, and the egress
 * of the container holds the host of the git source alone — a folder source
 * holds no host. A command that carries a plan moves the session to its build
 * phase: the realization restarts the container under the plan's host list over
 * the same tree, and a later plan restarts it again under the amended list.
 * `commit` runs the script in one new container over the pristine snapshot, and
 * that run alone writes the store. A `stop`, and a `commit` that answers
 * `committed`, end the session; the realization removes the container.
 *
 * `start`, `exec`, and `commit` take the abort signal of the turn. When it
 * fires, the realization stops the work of the call and the promise rejects:
 * an aborted `exec` stops its command inside the container, an aborted
 * `commit` stops the clean-run container, and an aborted `start` removes what
 * it made. The session of an aborted `exec` or `commit` stays open. `stop`
 * takes no signal, because it is short and it must finish.
 */
export type BuildSession = {
    start(source: BuildSource, analysisId: string, signal: AbortSignal): Promise<BuildSessionHandle>;
    exec(handle: string, command: BuildSessionCommand, signal: AbortSignal): Promise<BuildExecResult>;
    commit(handle: string, request: BuildCommitRequest, signal: AbortSignal): Promise<BuildCommitResult>;
    stop(handle: string): Promise<void>;
};

/**
 * Per-sandbox-machine liveness verdict. `oomKilled` is meaningful only when
 * `alive` is false: true when the backend reports the machine was killed for
 * exceeding its memory limit (Docker `State.OOMKilled`; K8s container
 * terminated reason `OOMKilled`) — the exec surfaces it as the
 * `sandbox-oom-killed` failure reason instead of the generic `sandbox-dead`.
 */
export type SandboxLiveness = {
    readonly alive: boolean;
    readonly oomKilled: boolean;
};

export type SandboxRef = PersistedSandboxRef;

/**
 * One tracked file operation in the sandbox-server provenance frame.
 * Mirrors Go's `ProvenanceEntry` (`images/sandbox-base/server/provenance.go`):
 * an absolute container path plus the capture layers that observed it.
 */
export const ProvenanceFrameEntrySchema = z.object({
    path: z.string(),
    layers: z.array(z.string()).default([]),
});
export type ProvenanceFrameEntry = z.infer<typeof ProvenanceFrameEntrySchema>;

/**
 * Runtime file-I/O frame sandbox-server attaches to the terminal result.
 * Mirrors Go's `provenancePayload` — every field is
 * `omitempty` on the wire, so each arm defaults so a completion that
 * omits the frame (or any arm) still parses.
 */
export const ProvenanceFrameSchema = z.object({
    disabled: z.boolean().default(false),
    reads: z.array(ProvenanceFrameEntrySchema).default([]),
    writes: z.array(ProvenanceFrameEntrySchema).default([]),
    /**
     * Reserved. All four sandbox capture layers report deletes per the
     * sandbox-provenance-tracking spec, but the harness has no consumer —
     * `feedExecFrame` reads only `reads`/`writes`. Kept on the wire for a
     * future invalidation mapping.
     */
    deletes: z.array(ProvenanceFrameEntrySchema).default([]),
});
export type ProvenanceFrame = z.infer<typeof ProvenanceFrameSchema>;

/**
 * What one exec cost the sandbox, as the kernel accounted it at reap time.
 * Mirrors Go's `resourceUsage` (`images/sandbox-base/server/executor.go`):
 * the peak resident set of the command and of every descendant it waited for,
 * and the CPU that same tree burned.
 *
 * Every member is tolerant. A sandbox image that predates the frame sends no
 * `usage` at all, an older or newer one can send a subset, and a malformed
 * frame falls back to absent rather than failing the parse — telemetry never
 * costs a caller its exec result.
 */
export const ExecUsageSchema = z
    .object({
        peakMemoryBytes: z.number().nonnegative().optional(),
        cpuMillis: z.number().nonnegative().optional(),
    })
    .optional()
    .catch(undefined);
export type ExecUsage = z.infer<typeof ExecUsageSchema>;

/**
 * Final outcome of a single exec, returned by `SandboxClient.exec`. Mirrors
 * the sandbox-server completion payload plus a discriminant for a synthetic
 * failure: the machine died under the exec.
 */
export const ExecResultSchema = z.object({
    execId: z.string(),
    exitCode: z.number().nullable(),
    stdout: z.string().default(""),
    stderr: z.string().default(""),
    durationMs: z.number().nullable(),
    timedOut: z.boolean().default(false),
    /**
     * Set when sandbox-server dropped output past the per-stream cap it was
     * given. The total is what the command actually produced, which is what
     * separates "printed nothing" from "printed more than we kept" — without it
     * a capped stream and an empty one are indistinguishable downstream.
     *
     * Optional because a sandbox image that pre-dates the cap omits both, and
     * because a synthetic failure carries neither.
     */
    stdoutTruncated: z.boolean().optional(),
    stderrTruncated: z.boolean().optional(),
    stdoutTotalBytes: z.number().int().nonnegative().optional(),
    stderrTotalBytes: z.number().int().nonnegative().optional(),
    /**
     * Set when the machine died under the exec, or when a new machine of the lease found the exec lost. The sandbox
     * module adds the memory limit of the grant, thus the agent can tell its own memory use from an outside cause.
     */
    syntheticFailure: z
        .object({
            reason: z.string(),
            memoryLimitGb: z.number().optional(),
        })
        .optional(),
    /** Set by sandbox-server on the record of an exec that a restart of the machine cut. */
    lost: z.object({ reason: z.string() }).optional(),
    /** Runtime file-I/O frame from sandbox-server. Absent from a synthetic failure. */
    provenance: ProvenanceFrameSchema.optional(),
    /**
     * Kernel accounting of the exec, for the sandbox-sizing histograms. Absent
     * from a synthetic failure, from a sandbox image that predates the
     * frame, and from any exec whose command never spawned.
     */
    usage: ExecUsageSchema,
});
export type ExecResult = z.infer<typeof ExecResultSchema>;

/**
 * One buffered progress event in a poll response: the sandbox's monotonic
 * per-exec sequence number (the poll cursor) plus the event payload the host
 * forwards via `emit`.
 */
export const PollEventSchema = z.object({
    seq: z.number().int(),
    payload: z.json(),
});
export type PollEvent = z.infer<typeof PollEventSchema>;

/**
 * Body of `GET /exec/{execId}?since={cursor}`. Mirrors Go's
 * `pollResponseBody`: the events newer than the caller's cursor, the new
 * high-water `cursor`, a `truncated` marker set once the ring shed an event,
 * and — once the exec is terminal — the completion `result` (with its
 * provenance frame).
 */
export const PollResponseSchema = z.object({
    status: z.enum(["running", "completed", "failed"]),
    events: z.array(PollEventSchema).default([]),
    cursor: z.number().int(),
    /**
     * Sticky ring-shed marker. Deliberately unused by the poll loop — the
     * seq-gap arithmetic detects sheds without it — but kept on the wire for
     * consumers that want the sandbox's own flag rather than deriving it.
     */
    truncated: z.boolean().default(false),
    result: ExecResultSchema.optional(),
});
export type PollResponse = z.infer<typeof PollResponseSchema>;

/**
 * One command for `SandboxClient.exec`. It carries no exec id: the exec
 * derives its id from the durable step it runs in.
 */
export type ExecRequest = {
    readonly command: readonly string[];
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutSeconds?: number;
};

/** Wire shape the exec POSTs to sandbox-server's `/exec`. */
export type SubmitExecBody = {
    command: string[];
    execId: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutSeconds?: number;
    /**
     * Per-stream retention budget for the sandbox. Omitting them leaves the
     * sandbox unbounded, which is how a server that pre-dates the fields
     * behaves; the host caps on receipt regardless, so the difference is how
     * many bytes cross the wire, not what the caller ends up with.
     */
    stdoutByteCap?: number;
    stderrByteCap?: number;
};

/** What a spawn needs beside its session. */
export type SandboxSpec = {
    /** The id of the lease workflow that owns the machine. Recorded verbatim on the
     *  machine under `cortex/owner-workflow-id`, thus the reconciler maps a machine
     *  back to its lease workflow. */
    ownerWorkflowId: string;
    /** The workspace-relative directory of the exec records of the lease. */
    recordTail: string;
    /** Backend-specific extras carried through to the per-backend impl. */
    image?: string;
    extraEnv?: Record<string, string>;
    /** CPU/memory/GPU request for the sandbox machine. Required of every
     *  caller — `createSandboxClient` clamps it to cluster limits. */
    resources: ResourceSpec;
    /** Enforced read-only: provision with no read-write step mount, only the
     *  read-only analysis tree for generic read-only agents. */
    readOnly?: boolean;
    /** Workspace-relative path that becomes the one read-write mount, in place of
     *  the step directory and with no step subdirectories under it. Each segment
     *  passes the safe-id discipline of the step builder. Absent keeps the step
     *  mount, thus a run provisions exactly as before. A tail beside `readOnly` is
     *  a contradiction, and the mount builders refuse it. */
    writableTail?: string;
};

/** The labels that the host adds to a sandbox. The harness stamps each one as the host gives it. */
export type SandboxLabels = Readonly<Record<string, string>>;

/**
 * The sandbox label hook of the host: a gate (`lib/hooks.ts`). The sandbox
 * client calls it at each spawn, on both backends, before it makes the step
 * tree and before it calls a backend.
 */
export type ResolveSandboxLabels = (session: RunSession) => ResultAsync<SandboxLabels, GateFailure>;

/**
 * The name of a sandbox machine. It comes from the lease workflow and the machine
 * generation, thus a rerun of the spawn step adopts the machine of the earlier
 * attempt instead of a second one.
 */
export type SandboxIdentity = {
    /** `sbx-{run8}-{hash12}`. */
    sandboxId: string;
};

/**
 * A sandbox machine the backend is running that Cortex *manages*
 * (`app.kubernetes.io/managed-by=cortex`), enumerated by the reconciler.
 * `ownerWorkflowId` is the id of the lease workflow as given, so it is usable as
 * a DBOS lookup key; null means the machine records no owner, and such a machine
 * is removed only past a creation-time grace and only when observably dead.
 */
export type ManagedSandbox = {
    sandboxId: string;
    ownerWorkflowId: string | null;
    createdAtMs: number | null;
};

/**
 * Progress callback of `SandboxClient.exec`, called with each sandbox event in
 * sequence order. The exec awaits each call before it polls again.
 */
export type ExecEmit = (event: unknown) => void | Promise<void>;
