/**
 * K8s-backed `createSandbox` / `teardown` / `isAlive`.
 *
 * Launches a sandbox Job with `CORTEX_BASE_URL` and `SANDBOX_CALLBACK_SECRET`
 * env vars; pod IP + port 8765 are the host/port Cortex POSTs `/exec` to.
 * Storage is wired via the shared session PVC: a flat read-only `volumeMount`
 * of the analysis tree at `/{resourceId}` plus a nested read-write mount of the
 * step's artifact dir, with the lib/ref stores mounted read-only at `/mnt/libs`
 * / `/mnt/refs` when their PVCs are set. Container paths and lib-store env come
 * from the shared mount plan; the PVC `subPath`s are derived from the same
 * `resolveWorkspaceRoot` seam the harness pre-creates the step tree under, so
 * both sides address one directory by construction.
 */

import { relative as relativePath, sep } from "node:path";

import { BatchV1Api, CoreV1Api, KubeConfig, type V1Job, type V1PodSpec, type V1Toleration, type V1Volume, type V1VolumeMount } from "@kubernetes/client-node";
import { ResultAsync, err, ok } from "neverthrow";

import type { ResolveWorkspaceRoot } from "../workspace/paths.js";
import { type SandboxError, trySandbox } from "./sandbox-error.js";
import { buildMountPlan, buildSessionSubPaths } from "./mount-plan.js";
import type { CreateSandboxMeta, ManagedSandbox, SandboxIdentity, SandboxLiveness, SandboxRef, SandboxTransport } from "./types.js";

/** Read the originating HTTP status off any `SandboxError` variant that carries one. */
function statusOf(e: SandboxError): number | undefined {
    return "status" in e ? e.status : undefined;
}

const SESSION_VOLUME_NAME = "session";
const LIBS_VOLUME_NAME = "libs";
const REFS_VOLUME_NAME = "refs";

const SANDBOX_SERVER_PORT = 8765;
const POD_READY_TIMEOUT_MS = 5 * 60_000;
const POD_POLL_INTERVAL_MS = 1_000;

const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
const MANAGED_BY_VALUE = "cortex";
const OWNER_WORKFLOW_LABEL = "cortex/owner-workflow-id";
const RUN_ID_LABEL = "cortex/run-id";
const STEP_ID_LABEL = "cortex/step-id";

/**
 * Coerce an arbitrary identifier into a valid K8s label value:
 * ≤63 chars, `[A-Za-z0-9._-]` only, starting and ending alphanumeric.
 * Workflow ids legitimately contain `:` (exec-id routing packs
 * `workflowId:stepId:fnId`), which is illegal in a label — without this an
 * otherwise-valid Job is rejected with a 422 at admission. Sanitization is a
 * no-op for already-valid ids, so DBOS-keyed lookups (adoption, reaper) match
 * unchanged; only the synthetic, non-DBOS data-profile id is rewritten.
 */
export function sanitizeLabelValue(value: string): string {
    return value
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .replace(/^[^A-Za-z0-9]+/, "")
        .slice(0, 63)
        .replace(/[^A-Za-z0-9]+$/, "");
}

export interface K8sClientConfig {
    image: string;
    cortexBaseUrl: string;
    /**
     * Result transport, threaded to the pod as `SANDBOX_TRANSPORT`. Poll-mode
     * confinement on K8s is a cluster-side NetworkPolicy, not an in-pod firewall.
     * Defaults to `poll`.
     */
    transport?: SandboxTransport;
    namespace: string;
    /** PVC claim backing the shared session PVC the workspace roots live under. */
    sessionPvc?: string;
    /**
     * Absolute mountpoint of `sessionPvc` on THIS process's filesystem. Required whenever
     * `sessionPvc` is set: a pod addresses the PVC by `subPath`, so the harness must be able
     * to express a resolved workspace root as a path relative to the volume's root. Every
     * root the embedder resolves must therefore live under this directory.
     */
    sessionPvcRoot?: string;
    /** Workspace-root resolution seam; the source of each analysis's PVC `subPath`. */
    resolveWorkspaceRoot: ResolveWorkspaceRoot;
    /** PVC claim mounted read-only at `/mnt/libs` when set. */
    libStorePvc?: string;
    /** PVC claim mounted read-only at `/mnt/refs` when set. */
    refStorePvc?: string;
    /** Node selector pinning sandbox pods to the dedicated agent pool. Omit for default scheduling. */
    nodeSelector?: Record<string, string>;
    /** Tolerations letting sandbox pods land on tainted agent nodes (e.g. `platform.io/agent-only:NoSchedule`). Omit for none. */
    tolerations?: V1Toleration[];
    /** RuntimeClass for runtime isolation (e.g. `gvisor`). Omit for the default runtime. */
    runtimeClassName?: string;
    /** Injected for tests. */
    batchApi?: BatchV1Api;
    coreApi?: CoreV1Api;
    registerSandbox: (meta: CreateSandboxMeta, ref: SandboxRef) => Promise<void>;
}

function deleteJobIgnoreMissing(batchApi: BatchV1Api, namespace: string, name: string): ResultAsync<void, SandboxError> {
    return trySandbox(
        async () => {
            await batchApi.deleteNamespacedJob({
                namespace,
                name,
                propagationPolicy: "Foreground",
            });
        },
        (status, cause) => ({
            type: "teardown_failed",
            op: "k8s.teardown",
            sandboxId: name,
            status,
            cause,
        }),
    ).orElse((e) =>
        // A 404 means the Job is already gone — an idempotent success.
        statusOf(e) === 404 ? ok(undefined) : err(e),
    );
}

function buildKubeApi(): { batchApi: BatchV1Api; coreApi: CoreV1Api } {
    const kc = new KubeConfig();
    // In-cluster when running on a pod, else from ~/.kube/config.
    try {
        kc.loadFromCluster();
    } catch {
        kc.loadFromDefault();
    }
    return {
        batchApi: kc.makeApiClient(BatchV1Api),
        coreApi: kc.makeApiClient(CoreV1Api),
    };
}

/**
 * Express an analysis's resolved workspace root as a path relative to the session PVC's root.
 * A root outside the PVC cannot be addressed by `subPath` at all, so the pod would silently
 * mount a directory the harness never wrote to — fail loudly instead. `createSandbox` runs
 * inside a DBOS workflow body, where a throw is the durable failure signal.
 */
function workspaceSubPathFor(config: K8sClientConfig, analysisId: string): string {
    if (!config.sessionPvcRoot) {
        throw new Error("k8s sandbox: sessionPvc is set but sessionPvcRoot is not — the PVC subPath of a workspace root cannot be derived");
    }
    const rel = relativePath(config.sessionPvcRoot, config.resolveWorkspaceRoot(analysisId));
    const posix = rel.split(sep).join("/");
    if (posix.length === 0 || posix.startsWith("..")) {
        throw new Error(`k8s sandbox: workspace root for ${analysisId} does not live under sessionPvcRoot (${config.sessionPvcRoot})`);
    }
    return posix;
}

function buildJobSpec(meta: CreateSandboxMeta, config: K8sClientConfig, identity: SandboxIdentity): V1Job {
    const { sandboxId } = identity;
    const plan = buildMountPlan(meta, {
        libs: !!config.libStorePvc,
        refs: !!config.refStorePvc,
    });

    const transport = config.transport ?? "poll";
    const env = [
        { name: "SANDBOX_TRANSPORT", value: transport },
        // Poll mode never dials out, so the URL is omitted (matching the Docker
        // backend) — the pod spec itself then documents that no callback egress
        // is expected. sandbox-server neither reads nor requires it in poll mode.
        ...(transport === "callback" ? [{ name: "CORTEX_BASE_URL", value: config.cortexBaseUrl }] : []),
        { name: "SANDBOX_CALLBACK_SECRET", value: identity.callbackSecret },
        ...Object.entries(plan.env).map(([name, value]) => ({ name, value })),
        ...Object.entries(meta.extraEnv ?? {}).map(([k, v]) => ({
            name: k,
            value: v,
        })),
    ];

    // requests == limits → Guaranteed QoS and a predictable OOM bound; also
    // satisfies the namespace ResourceQuota, which rejects any pod that omits
    // requests.cpu/memory. The CPU limit can throttle a hot step, but a throttle
    // beats an eviction.
    const spec = meta.resources;
    const quantities: Record<string, string> = {
        cpu: String(spec.cpu),
        memory: `${spec.memoryGb}Gi`,
    };
    if (spec.gpu) quantities["nvidia.com/gpu"] = String(spec.gpu.count);
    const resources = { requests: quantities, limits: quantities };

    const volumes: V1Volume[] = [];
    const volumeMounts: V1VolumeMount[] = [];

    if (config.sessionPvc) {
        const subPaths = buildSessionSubPaths(meta, workspaceSubPathFor(config, meta.analysisId));
        volumes.push({
            name: SESSION_VOLUME_NAME,
            persistentVolumeClaim: { claimName: config.sessionPvc },
        });
        // Most-specific path wins: the nested RW mount shadows the RO tree at
        // the step subtree. A read-only sandbox omits the RW mount entirely —
        // only the read-only tree is mounted.
        volumeMounts.push({
            name: SESSION_VOLUME_NAME,
            mountPath: plan.readonlyTreePath,
            subPath: subPaths.ro,
            readOnly: true,
        });
        if (plan.writableStepPath && subPaths.rw) {
            volumeMounts.push({
                name: SESSION_VOLUME_NAME,
                mountPath: plan.writableStepPath,
                subPath: subPaths.rw,
                readOnly: false,
            });
        }
    }

    if (config.libStorePvc && plan.libsPath) {
        volumes.push({
            name: LIBS_VOLUME_NAME,
            persistentVolumeClaim: { claimName: config.libStorePvc, readOnly: true },
        });
        volumeMounts.push({
            name: LIBS_VOLUME_NAME,
            mountPath: plan.libsPath,
            readOnly: true,
        });
    }

    if (config.refStorePvc && plan.refsPath) {
        volumes.push({
            name: REFS_VOLUME_NAME,
            persistentVolumeClaim: { claimName: config.refStorePvc, readOnly: true },
        });
        volumeMounts.push({
            name: REFS_VOLUME_NAME,
            mountPath: plan.refsPath,
            readOnly: true,
        });
    }

    const podSpec: V1PodSpec = {
        automountServiceAccountToken: false,
        restartPolicy: "Never",
        containers: [
            {
                name: "sandbox",
                image: meta.image ?? config.image,
                imagePullPolicy: "IfNotPresent",
                env,
                resources,
                workingDir: plan.workingDir,
                volumeMounts,
                ports: [{ containerPort: SANDBOX_SERVER_PORT }],
                securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: false,
                    capabilities: { drop: ["ALL"] },
                },
            },
        ],
        volumes,
        securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
        },
    };

    // Pin sandbox pods to the dedicated agent pool and isolate them under the
    // configured RuntimeClass (gVisor). Each field is omitted when unset so the
    // default-scheduling / default-runtime behaviour is preserved.
    if (config.nodeSelector) podSpec.nodeSelector = config.nodeSelector;
    if (config.tolerations) podSpec.tolerations = config.tolerations;
    if (config.runtimeClassName) podSpec.runtimeClassName = config.runtimeClassName;

    return {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
            name: sandboxId,
            namespace: config.namespace,
            labels: {
                [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
                role: "sandbox",
                "cortex/sandbox-id": sandboxId,
                [OWNER_WORKFLOW_LABEL]: sanitizeLabelValue(meta.childWorkflowId),
                [RUN_ID_LABEL]: sanitizeLabelValue(meta.runId),
                [STEP_ID_LABEL]: sanitizeLabelValue(meta.stepId),
            },
        },
        spec: {
            backoffLimit: 0,
            ttlSecondsAfterFinished: 60,
            template: {
                metadata: {
                    labels: {
                        role: "sandbox",
                        "cortex/sandbox-id": sandboxId,
                    },
                },
                spec: podSpec,
            },
        },
    };
}

interface PodStatusSnapshot {
    phase?: string;
    podIP?: string;
    podName?: string;
}

function waitForPodReady(coreApi: CoreV1Api, namespace: string, sandboxId: string): ResultAsync<{ podIP: string; podName: string }, SandboxError> {
    const createFailed = (status: number | undefined, cause: unknown): SandboxError => ({
        type: "container_create_failed",
        op: "k8s.waitForPodReady",
        sandboxId,
        status,
        cause,
    });
    return new ResultAsync(
        (async () => {
            const deadline = Date.now() + POD_READY_TIMEOUT_MS;
            let lastSnapshot: PodStatusSnapshot = {};
            while (Date.now() < deadline) {
                const listed = await trySandbox(
                    () =>
                        coreApi.listNamespacedPod({
                            namespace,
                            labelSelector: `cortex/sandbox-id=${sandboxId}`,
                        }),
                    createFailed,
                );
                if (listed.isErr()) return err(listed.error);
                const pod = listed.value.items[0];
                lastSnapshot = {
                    phase: pod?.status?.phase,
                    podIP: pod?.status?.podIP,
                    podName: pod?.metadata?.name,
                };
                if (pod && pod.status?.phase === "Running" && typeof pod.status.podIP === "string" && pod.metadata?.name) {
                    return ok({ podIP: pod.status.podIP, podName: pod.metadata.name });
                }
                if (pod?.status?.phase === "Failed") {
                    return err(createFailed(undefined, new Error(`K8sSandbox ${sandboxId}: pod phase=Failed before becoming ready`)));
                }
                await new Promise((r) => setTimeout(r, POD_POLL_INTERVAL_MS));
            }
            return err(
                createFailed(
                    undefined,
                    new Error(
                        `K8sSandbox ${sandboxId}: pod did not reach Running within ` + `${POD_READY_TIMEOUT_MS}ms (last: ${JSON.stringify(lastSnapshot)})`,
                    ),
                ),
            );
        })(),
    );
}

/** The single pod behind a sandbox Job is in a terminal phase — a genuinely
 *  dead prior attempt, not a machine we should adopt. */
function existingPodIsTerminal(coreApi: CoreV1Api, namespace: string, sandboxId: string): ResultAsync<boolean, SandboxError> {
    return trySandbox(
        () =>
            coreApi.listNamespacedPod({
                namespace,
                labelSelector: `cortex/sandbox-id=${sandboxId}`,
            }),
        (status, cause) => ({
            type: "container_create_failed",
            op: "k8s.existingPodIsTerminal",
            sandboxId,
            status,
            cause,
        }),
    ).map((pods) => {
        const phase = pods.items[0]?.status?.phase;
        return phase === "Failed" || phase === "Succeeded";
    });
}

/** Poll until a deleted Job's name is free again — K8s deletion is async, and
 *  recreating under the same name before the old object is gone 409s. */
function waitForJobGone(batchApi: BatchV1Api, namespace: string, name: string): ResultAsync<void, SandboxError> {
    const createFailed = (status: number | undefined, cause: unknown): SandboxError => ({
        type: "container_create_failed",
        op: "k8s.waitForJobGone",
        sandboxId: name,
        status,
        cause,
    });
    return new ResultAsync(
        (async () => {
            const deadline = Date.now() + 60_000;
            while (Date.now() < deadline) {
                const read = await trySandbox(() => batchApi.readNamespacedJob({ namespace, name }), createFailed);
                // A 404 means the prior Job is finally gone — the name is free.
                if (read.isErr()) {
                    if (statusOf(read.error) === 404) return ok(undefined);
                    return err(read.error);
                }
                await new Promise((r) => setTimeout(r, 500));
            }
            return err(createFailed(undefined, new Error(`K8sSandbox ${name}: prior Job did not delete within 60s`)));
        })(),
    );
}

/**
 * Create the Job, or adopt an existing one on `409 AlreadyExists` — the
 * recovery re-run of the spawn step (see the harness-sandbox-exec spec). A live/starting pod is adopted
 * as-is (the caller's `waitForPodReady` picks up its IP). A terminal pod is a
 * dead prior attempt under the same checkpointed name: delete it, wait for the
 * name to free, and recreate fresh.
 *
 * Adoption (and deletion) is **owner-guarded**: the existing Job's
 * `cortex/owner-workflow-id` label must match this step's `ownerWorkflowId`.
 * Only a recovery re-run carries the same checkpointed identity, so a mismatch
 * means an (astronomically rare) name collision with a *different* step —
 * adopting its pod would HMAC-fail every callback, and deleting its Job would
 * kill a live sibling. Refuse loudly instead.
 */
function createOrAdoptJob(
    batchApi: BatchV1Api,
    coreApi: CoreV1Api,
    namespace: string,
    sandboxId: string,
    ownerWorkflowId: string,
    job: V1Job,
): ResultAsync<void, SandboxError> {
    const createFailed = (status: number | undefined, cause: unknown): SandboxError => ({
        type: "container_create_failed",
        op: "k8s.createNamespacedJob",
        sandboxId,
        status,
        cause,
    });
    return new ResultAsync(
        (async () => {
            const created = await trySandbox(() => batchApi.createNamespacedJob({ namespace, body: job }), createFailed);
            if (created.isOk()) return ok(undefined);
            if (statusOf(created.error) !== 409) return err(created.error);

            const existingRead = await trySandbox(() => batchApi.readNamespacedJob({ namespace, name: sandboxId }), createFailed);
            if (existingRead.isErr()) return err(existingRead.error);
            const owner = existingRead.value.metadata?.labels?.[OWNER_WORKFLOW_LABEL];
            if (owner !== ownerWorkflowId) {
                return err({
                    type: "name_conflict",
                    op: "k8s.createSandbox",
                    sandboxId,
                    owner: owner ?? null,
                });
            }

            const terminal = await existingPodIsTerminal(coreApi, namespace, sandboxId);
            if (terminal.isErr()) return err(terminal.error);
            if (terminal.value) {
                const deleted = await deleteJobIgnoreMissing(batchApi, namespace, sandboxId);
                if (deleted.isErr()) return err(deleted.error);
                const gone = await waitForJobGone(batchApi, namespace, sandboxId);
                if (gone.isErr()) return err(gone.error);
                const recreated = await trySandbox(() => batchApi.createNamespacedJob({ namespace, body: job }), createFailed);
                if (recreated.isErr()) return err(recreated.error);
            }
            return ok(undefined);
        })(),
    );
}

export function createK8sSandboxOps(config: K8sClientConfig): {
    createSandbox(meta: CreateSandboxMeta, identity: SandboxIdentity): ResultAsync<SandboxRef, SandboxError>;
    teardown(ref: SandboxRef): ResultAsync<void, SandboxError>;
    teardownById(sandboxId: string): ResultAsync<void, SandboxError>;
    isAlive(ref: SandboxRef): ResultAsync<SandboxLiveness, SandboxError>;
    listManagedSandboxes(): ResultAsync<ManagedSandbox[], SandboxError>;
} {
    const { batchApi, coreApi } = config.batchApi && config.coreApi ? { batchApi: config.batchApi, coreApi: config.coreApi } : buildKubeApi();

    return {
        createSandbox(meta, identity) {
            return new ResultAsync(
                (async () => {
                    const { sandboxId } = identity;
                    const job = buildJobSpec(meta, config, identity);

                    const adopted = await createOrAdoptJob(batchApi, coreApi, config.namespace, sandboxId, sanitizeLabelValue(meta.childWorkflowId), job);
                    if (adopted.isErr()) return err(adopted.error);

                    // A Job whose pod never schedules (quota rejection, no nodes, spot
                    // reclaim) is reaped by neither backoffLimit (an admission rejection
                    // creates no pod to count) nor ttlSecondsAfterFinished (the Job never
                    // finishes) — the Job controller retries pod creation forever. Delete
                    // the Job on any startup failure so a failed create can't leak a
                    // zombie that floods k8s events indefinitely.
                    const ready = await waitForPodReady(coreApi, config.namespace, sandboxId);
                    if (ready.isOk()) {
                        const ref: SandboxRef = {
                            sandboxId,
                            host: ready.value.podIP,
                            port: SANDBOX_SERVER_PORT,
                            backend: "k8s",
                            callbackSecret: identity.callbackSecret,
                        };
                        const registered = await trySandbox(
                            () => config.registerSandbox(meta, ref),
                            (status, cause) => ({
                                type: "container_create_failed",
                                op: "k8s.registerSandbox",
                                sandboxId,
                                status,
                                cause,
                            }),
                        );
                        if (registered.isErr()) {
                            await cleanupFailedJob(batchApi, config.namespace, sandboxId);
                            return err(registered.error);
                        }
                        return ok(ref);
                    }
                    await cleanupFailedJob(batchApi, config.namespace, sandboxId);
                    return err(ready.error);
                })(),
            );
        },

        teardown(ref) {
            return deleteJobIgnoreMissing(batchApi, config.namespace, ref.sandboxId);
        },

        teardownById(sandboxId) {
            return deleteJobIgnoreMissing(batchApi, config.namespace, sandboxId);
        },

        listManagedSandboxes() {
            return trySandbox(
                () =>
                    batchApi.listNamespacedJob({
                        namespace: config.namespace,
                        labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
                    }),
                (status, cause) => ({
                    type: "liveness_failed",
                    op: "k8s.listManagedSandboxes",
                    status,
                    cause,
                }),
            ).map((jobs) =>
                jobs.items
                    .map((j) => {
                        const labels = j.metadata?.labels ?? {};
                        const ts = j.metadata?.creationTimestamp;
                        return {
                            sandboxId: labels["cortex/sandbox-id"] ?? j.metadata?.name ?? "",
                            ownerWorkflowId: labels[OWNER_WORKFLOW_LABEL] ?? null,
                            createdAtMs: ts ? new Date(ts).getTime() : null,
                        };
                    })
                    .filter((s) => s.sandboxId.length > 0),
            );
        },

        isAlive(ref) {
            return trySandbox(
                () =>
                    coreApi.listNamespacedPod({
                        namespace: config.namespace,
                        labelSelector: `cortex/sandbox-id=${ref.sandboxId}`,
                    }),
                (status, cause) => ({
                    type: "liveness_failed",
                    op: "k8s.isAlive",
                    sandboxId: ref.sandboxId,
                    status,
                    cause,
                }),
            )
                .map((pods) => {
                    const pod = pods.items[0];
                    if (!pod) return { alive: false, oomKilled: false };
                    const phase = pod.status?.phase;
                    // `Pending` and `Running` are alive; `Succeeded`, `Failed`,
                    // `Unknown` are dead. `Pending` covers startup.
                    const alive = phase === "Pending" || phase === "Running";
                    const oomKilled =
                        !alive &&
                        (pod.status?.containerStatuses ?? []).some(
                            (cs) => cs.state?.terminated?.reason === "OOMKilled" || cs.lastState?.terminated?.reason === "OOMKilled",
                        );
                    return { alive, oomKilled };
                })
                .orElse((e) =>
                    // A 404 means the pod is gone — observably dead.
                    statusOf(e) === 404 ? ok({ alive: false, oomKilled: false }) : err(e),
                );
        },
    };
}

/**
 * Best-effort Job removal after a failed create. The original failure is what
 * matters; a delete error here is logged and swallowed so it never masks the
 * create error returned to the caller.
 */
async function cleanupFailedJob(batchApi: BatchV1Api, namespace: string, sandboxId: string): Promise<void> {
    const deleted = await deleteJobIgnoreMissing(batchApi, namespace, sandboxId);
    if (deleted.isErr()) {
        console.error(`K8sSandbox: failed to delete Job ${sandboxId} after startup failure`, deleted.error);
    }
}
