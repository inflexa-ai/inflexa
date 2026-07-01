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
 * `payloadRaw` is the exact bytes sandbox-server POSTed — sandbox-server's
 * HMAC signs the raw body, and Go's `encoding/json` HTML-escapes `<`, `>`,
 * `&` by default, so verifying against a JS re-serialization of the parsed
 * payload would diverge for any output containing those characters
 * (common in bioinformatics: FASTA headers, shell stderr, command pipelines).
 * Optional only for back-compat with messages that pre-date this field.
 */
export const ExecEventMessageSchema = z.object({
    payload: z.unknown(),
    payloadRaw: z.string().optional(),
    signature: z.string().nullable(),
    timestamp: z.number().int().nullable(),
});
export type ExecEventMessage = z.infer<typeof ExecEventMessageSchema>;

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
}

/** Step-meta passed to `createSandbox` — what the registry row needs. */
export interface CreateSandboxMeta {
    runId: string;
    stepId: string;
    analysisId: string;
    /** The first `execId` that will fire against this sandbox; nullable for
     *  early-create flows where the workflow mints the first execId later. */
    execId?: string | null;
    /** Owning DBOS child workflow id (`"${parentRunId}-${N}"`). Stamped onto the
     *  sandbox machine as the `cortex/owner-workflow-id` label so the reaper can
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
     *  read-only analysis tree. Used by the ephemeral executor. */
    readOnly?: boolean;
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
 * cluster→registry sweep (see the harness-sandbox-exec spec). The `ownerWorkflowId` comes from the
 * `cortex/owner-workflow-id` label and may be null for legacy/label-less
 * machines, which are only reaped past a creation-time grace.
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
