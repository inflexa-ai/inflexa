/**
 * Sandbox-client types — the wire/persistence shapes that cross the
 * submit/recv protocol (see the harness-sandbox-exec spec) and the active-sandbox registry.
 *
 * `SandboxRef` is the in-memory handle the harness uses to talk to a live
 * sandbox; it carries the per-sandbox `callbackSecret` (see the harness-sandbox-exec spec). The
 * persistable subset is `PersistedSandboxRef` (from `harness/state/schema.ts`)
 * — that one OMITS the secret, which lives only in the cached
 * `createSandbox` DBOS step output.
 */

import { z } from "zod";

import type { ResourceSpec } from "../config/resource-limits.js";
import { PersistedSandboxRefSchema } from "../state/schema.js";

export const SandboxBackend = z.enum(["docker", "k8s"]);
export type SandboxBackend = z.infer<typeof SandboxBackend>;

/**
 * How a command's progress events and terminal result reach the host. Chosen by
 * the embedder at its composition root and carried into the container as
 * `SANDBOX_TRANSPORT`; backend-independent. The OSS default is `poll`.
 *
 * - `poll`: the host polls `GET /exec/{execId}?since={cursor}`; the sandbox
 *   never dials out and needs no egress.
 * - `callback`: the sandbox POSTs signed event/completion callbacks; the
 *   embedder runs an ingress. `GET /exec/{execId}` stays the recovery backstop.
 */
export const SandboxTransportSchema = z.enum(["poll", "callback"]);
export type SandboxTransport = z.infer<typeof SandboxTransportSchema>;

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
export interface FarmLocation {
    readonly farmPath: string;
    readonly cachePath?: string;
}

/** The answer of a farm resolver: a usable farm, or a refusal that carries the reason of the embedder. */
export type FarmResolution = { readonly kind: "available"; readonly location: FarmLocation } | { readonly kind: "unavailable"; readonly reason: string };

/** Resolve the farm of one analysis. A backend calls this at each `createSandbox`, thus a new farm reaches the next sandbox with no restart. */
export type ResolveAnalysisFarm = (analysisId: string) => Promise<FarmResolution>;

/**
 * Where the farm of an analysis comes from. A required field of each sandbox
 * backend config — the harness never invents a farm location, and it reads
 * no store-root `current` pointer. `fixed` names one farm for every
 * analysis. `per-analysis` supplies a resolver.
 */
export type FarmSource = { readonly kind: "fixed"; readonly location: FarmLocation } | { readonly kind: "per-analysis"; readonly resolve: ResolveAnalysisFarm };

/**
 * One package ask of the farm-extension seam. `version` pins one exact
 * version. `ecosystem` qualifies a name that both tracks can hold. Without
 * it, a name that both tracks hold comes back as a `collision` outcome.
 */
export interface PackageRequest {
    readonly name: string;
    readonly version?: string;
    readonly ecosystem?: "python" | "r";
}

/**
 * One outcome per request, index-aligned with the request array.
 * - `linked` — the pool held the package, and this call linked it.
 * - `present` — the farm linked it already.
 * - `absent` — the pool does not hold it. `acquisitionPossible` states that
 *   the host can acquire that ecosystem, or that it cannot. `detail`, when
 *   the realization gives one, classifies the miss in host terms — in
 *   flight, failed with a recorded reason, or never requested — and the
 *   launch refusal renders it beside the name.
 * - `collision` — the request resolves to two store directories: two
 *   versions of one distribution, or one name that both tracks hold. The
 *   outcome is terminal for the request. `detail`, when the realization
 *   gives one, names the two pins and the packages that need each side —
 *   without it, a caller must guess which package pulls each pin, and a
 *   wrong guess sends it into store surgery.
 * - `unavailable` — the link pass itself could not answer: an unreadable
 *   dependency graph, a locked farm. The reason says why. It says NOTHING
 *   about the presence of the package, and it must never render as an
 *   absence — a false absence sends a caller chasing packages the pool
 *   holds.
 */
export type PackageRequestOutcome =
    | { readonly kind: "linked"; readonly name: string; readonly version: string }
    | { readonly kind: "present"; readonly name: string; readonly version: string }
    | { readonly kind: "absent"; readonly name: string; readonly acquisitionPossible: boolean; readonly detail?: string }
    | { readonly kind: "collision"; readonly name: string; readonly storeDirs: readonly [string, string]; readonly detail?: string }
    | { readonly kind: "unavailable"; readonly name: string; readonly reason: string };

/**
 * The farm-extension seam. The realization of the embedder links host-staged
 * packages into the farm of the analysis. It never installs, downloads, or
 * acquires. A link is live in a sandbox that already runs, because the farm
 * rides a bind mount.
 */
export type ExtendAnalysisFarm = (analysisId: string, requests: readonly PackageRequest[]) => Promise<readonly PackageRequestOutcome[]>;

/**
 * Per-sandbox-machine liveness verdict. `oomKilled` is meaningful only when
 * `alive` is false: true when the backend reports the machine was killed for
 * exceeding its memory limit (Docker `State.OOMKilled`; K8s container
 * terminated reason `OOMKilled`) — the watchdog surfaces it as the
 * `sandbox-oom-killed` failure reason instead of the generic `sandbox-dead`.
 */
export interface SandboxLiveness {
    readonly alive: boolean;
    readonly oomKilled: boolean;
}

export const SandboxRefSchema = PersistedSandboxRefSchema.extend({
    /**
     * 32-byte high-entropy bytes, base64-encoded. Minted once at
     * `createSandbox` and handed to the sandbox container via
     * `SANDBOX_CALLBACK_SECRET`. Never persisted outside the DBOS
     * step-output cache.
     */
    callbackSecret: z.string(),
});
export type SandboxRef = z.infer<typeof SandboxRefSchema>;

/** Strip the secret before persisting to the active-sandbox registry. */
export function toPersistedRef(ref: SandboxRef): {
    sandboxId: string;
    host: string;
    port: number;
    backend: SandboxBackend;
} {
    return {
        sandboxId: ref.sandboxId,
        host: ref.host,
        port: ref.port,
        backend: ref.backend,
    };
}

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
 * Runtime file-I/O frame sandbox-server attaches to the `/complete`
 * callback. Mirrors Go's `provenancePayload` — every field is
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
 * Final outcome of a single exec, returned by `awaitExec`. Mirrors the
 * sandbox-server completion payload plus a discriminant for synthetic
 * (watchdog-emitted) failures.
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
     * because the watchdog's synthetic failures carry neither.
     */
    stdoutTruncated: z.boolean().optional(),
    stderrTruncated: z.boolean().optional(),
    stdoutTotalBytes: z.number().int().nonnegative().optional(),
    stderrTotalBytes: z.number().int().nonnegative().optional(),
    /** Set when the watchdog synthesises a completion for a dead sandbox. */
    syntheticFailure: z
        .object({
            reason: z.string(),
        })
        .optional(),
    /**
     * Runtime file-I/O frame from sandbox-server. Optional so synthetic
     * watchdog failures and pre-change cached recv messages parse; rides
     * the recv payload into the durable DBOS step output.
     */
    provenance: ProvenanceFrameSchema.optional(),
});
export type ExecResult = z.infer<typeof ExecResultSchema>;

/**
 * Per-message envelope on the per-exec DBOS topic. Real callbacks carry
 * a non-null `signature` and `timestamp`; the in-process watchdog uses a
 * `null` signature + a `synthetic-failure` payload (see `await-exec.ts`).
 *
 * `payloadDigest` is the hex SHA-256 of the exact bytes sandbox-server POSTed.
 * The HMAC signs that digest rather than the body itself, so the digest is all
 * verification needs — and carrying it instead of the bytes keeps the message
 * from holding a second copy of a payload that can be arbitrarily large.
 * Re-serializing the parsed payload would not do: Go's `encoding/json`
 * HTML-escapes `<`, `>`, `&` by default, so a JS re-serialization diverges for
 * any output containing those characters (common in bioinformatics: FASTA
 * headers, shell stderr, command pipelines).
 *
 * `payloadRaw` is the superseded form, kept optional so messages already in
 * flight or persisted still verify.
 */
export const ExecEventMessageSchema = z.object({
    payload: z.unknown(),
    payloadDigest: z.string().optional(),
    payloadRaw: z.string().optional(),
    signature: z.string().nullable(),
    timestamp: z.number().int().nullable(),
});
export type ExecEventMessage = z.infer<typeof ExecEventMessageSchema>;

/**
 * One buffered progress event in a poll response: the sandbox's monotonic
 * per-exec sequence number (the poll cursor) plus the event payload the host
 * forwards via `emit` — the same payload a callback-mode event POST carries.
 */
export const PollEventSchema = z.object({
    seq: z.number().int(),
    payload: z.unknown(),
});
export type PollEvent = z.infer<typeof PollEventSchema>;

/**
 * Body of `GET /exec/{execId}?since={cursor}` in poll mode. Mirrors Go's
 * `pollResponseBody`: the events newer than the caller's cursor, the new
 * high-water `cursor`, a `truncated` marker set once the ring shed an event,
 * and — once the exec is terminal — the completion `result` (with its
 * provenance frame). The whole body is HMAC-signed, verified exactly as a
 * pushed completion is.
 */
export const PollResponseSchema = z.object({
    status: z.string(),
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
 * Done-marker shape the recv loop unwraps. Both real completion POSTs
 * (wrapped by the `/complete` handler) and watchdog synthetic-failure
 * sends use this discriminant.
 */
export interface DoneMarker {
    done: true;
    result: ExecResult;
}

export interface SyntheticFailureMarker {
    done: true;
    result: ExecResult;
    kind: "synthetic-failure";
    reason: string;
}

export function isDoneMarker(value: unknown): value is DoneMarker {
    return (
        typeof value === "object" && value !== null && (value as { done?: unknown }).done === true && typeof (value as { result?: unknown }).result === "object"
    );
}

export function isSyntheticFailure(value: unknown): value is SyntheticFailureMarker {
    return isDoneMarker(value) && (value as { kind?: unknown }).kind === "synthetic-failure";
}

/** Wire shape `submitExec` POSTs to sandbox-server's `/exec` (change 4). */
export interface SubmitExecBody {
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
}

/** Step-meta passed to `createSandbox` — what the registry row needs. */
export interface CreateSandboxMeta {
    runId: string;
    stepId: string;
    analysisId: string;
    /** The first `execId` that will fire against this sandbox; nullable for
     *  early-create flows where the workflow mints the first execId later. */
    execId?: string | null;
    /** Owning DBOS child workflow id (`"${parentRunId}-${N}"`). Recorded verbatim
     *  on the sandbox machine under `cortex/owner-workflow-id` so the reaper can
     *  map a cluster-side machine back to its workflow and check liveness. */
    childWorkflowId: string;
    /** Backend-specific extras carried through to the per-backend impl. */
    image?: string;
    extraEnv?: Record<string, string>;
    /** CPU/memory/GPU request for the sandbox machine. Required of every
     *  caller — `createSandboxClient` clamps it to cluster limits and rejects
     *  a sandbox with none. */
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
    /** Host-supplied labels stamped onto the sandbox pod, verbatim. Opaque here:
     *  the harness reads no key and no value, it only sanitizes each value into a
     *  valid label. Absent ⇒ the pod carries the harness's own labels only. */
    podLabels?: Record<string, string>;
}

/**
 * The identity minted for a sandbox machine *before* it is spawned — the
 * durable half of the two-step create (see the harness-sandbox-exec spec). Step 1 checkpoints this so a
 * recovery re-run of the spawn step adopts the already-created machine under
 * the same name and HMAC secret instead of leaking a second one.
 */
export interface SandboxIdentity {
    /** `sbx-{run8}-{uuid4}` — informative for `kubectl`, not load-bearing; the
     *  checkpoint, not the name, is what makes create idempotent. */
    sandboxId: string;
    /** 32-byte base64 HMAC secret (see the harness-sandbox-exec spec); rides into the machine's env. */
    callbackSecret: string;
}

/**
 * A sandbox machine the backend is running that Cortex *manages*
 * (`app.kubernetes.io/managed-by=cortex`), enumerated by the reaper for the
 * cluster→registry sweep (see the harness-sandbox-exec spec). `ownerWorkflowId`
 * is the id as minted, so it is usable as a DBOS lookup key; null means the
 * machine records no owner, and such a machine is reaped only past a
 * creation-time grace and only when observably dead.
 */
export interface ManagedSandbox {
    sandboxId: string;
    ownerWorkflowId: string | null;
    createdAtMs: number | null;
}

/**
 * Per-step `emit` callback handed to `awaitExec`. May be async — `awaitExec`
 * runs in the workflow body (see the harness-tools spec) and `await`s each emit so the body-path
 * `DBOS.writeStream` it drives lands at a deterministic function-ID (see the harness-durable-runtime spec).
 */
export type ExecEmit = (event: unknown) => void | Promise<void>;
