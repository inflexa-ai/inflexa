/**
 * K8s `createSandbox` / `teardown` / `isAlive` shape tests against
 * stubbed BatchV1Api / CoreV1Api. Verifies the Job spec carries the
 * required env vars, teardown is idempotent on 404, and isAlive maps
 * pod phase correctly.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BatchV1Api, CoreV1Api, V1Job, V1Pod } from "@kubernetes/client-node";

import { createK8sSandboxOps, sanitizeLabelValue } from "./k8s-client.js";
import { mintSandboxIdentity } from "./identity.js";
import type { FarmSource } from "./types.js";

/** The conventional managed layout: workspace roots sit directly under the PVC mountpoint. */
const SESSION_PVC_ROOT = "/sessions";
const resolveWorkspaceRoot = (analysisId: string) => `${SESSION_PVC_ROOT}/${analysisId}`;

/** The managed shape: one farm location, PVC-relative, for every analysis. */
const FIXED_FARM: FarmSource = { kind: "fixed", location: { farmPath: "farms/catalog" } };

function stubApis(podSequence: Array<Partial<V1Pod>>, opts: { create409Times?: number; existingOwner?: string } = {}) {
    const createdJobs: V1Job[] = [];
    const deletedJobs: string[] = [];
    let podIdx = 0;
    let deletedError: { code: number } | null = null;
    let pending409 = opts.create409Times ?? 0;
    let existingDeleted = false;
    const existingOwner = opts.existingOwner ?? "run-1-0";

    const batchApi = {
        createNamespacedJob: async ({ body }: { namespace: string; body: V1Job }) => {
            if (pending409 > 0) {
                pending409--;
                // Mirror `@kubernetes/client-node` `ApiException`: status on `.code`.
                const err = new Error("jobs.batch already exists") as Error & {
                    code: number;
                };
                err.code = 409;
                throw err;
            }
            createdJobs.push(body);
            return { metadata: { name: body.metadata?.name, uid: "job-uid-1" } };
        },
        deleteNamespacedJob: async ({ name }: { namespace: string; name: string }) => {
            if (deletedError) throw deletedError;
            existingDeleted = true;
            deletedJobs.push(name);
        },
        // Used by the spawn step's owner-guard (returns the pre-existing Job with
        // its recorded owner) and then by `waitForJobGone` after a delete (404).
        listNamespacedJob: async (_args: { namespace: string; labelSelector?: string }) => ({ items: createdJobs }),
        readNamespacedJob: async ({ name }: { namespace: string; name: string }) => {
            if (existingDeleted) {
                const err = new Error("not found") as Error & { code: number };
                err.code = 404;
                throw err;
            }
            return { metadata: { name, uid: "job-uid-existing", annotations: { "cortex/owner-workflow-id": existingOwner } } };
        },
    } as unknown as BatchV1Api;

    const coreApi = {
        listNamespacedPod: async (_args: { namespace: string; labelSelector?: string }) => {
            const pod = podSequence[Math.min(podIdx, podSequence.length - 1)];
            podIdx++;
            return { items: pod ? [pod as V1Pod] : [] };
        },
    } as unknown as CoreV1Api;

    return {
        batchApi,
        coreApi,
        createdJobs,
        deletedJobs,
        setDeleteError: (err: { code: number } | null) => {
            deletedError = err;
        },
    };
}

describe("k8s createSandbox", () => {
    test("callback mode creates a Job carrying CORTEX_BASE_URL and SANDBOX_CALLBACK_SECRET env", async () => {
        const stub = stubApis([
            {
                status: { phase: "Running", podIP: "10.0.0.1" },
                metadata: { name: "sbx-x-abc" },
            },
        ]);
        const registered: string[] = [];

        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://cortex.example.com:443",
            transport: "callback",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            libStorePvc: "cortex-libs",
            refStorePvc: "cortex-refs",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async (_meta, ref) => {
                registered.push(ref.sandboxId);
            },
        });

        const ref = (
            await ops.createSandbox(
                {
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        expect(ref.backend).toBe("k8s");
        expect(ref.host).toBe("10.0.0.1");
        expect(ref.port).toBe(8765);
        expect(ref.callbackSecret.length).toBeGreaterThan(40);

        expect(stub.createdJobs).toHaveLength(1);
        const podSpec = stub.createdJobs[0]!.spec!.template.spec!;
        const container = podSpec.containers[0];
        const env = container.env ?? [];
        const envMap = Object.fromEntries(env.map((e) => [e.name, e.value]));
        expect(envMap.SANDBOX_TRANSPORT).toBe("callback");
        expect(envMap.CORTEX_BASE_URL).toBe("https://cortex.example.com:443");
        expect(envMap.SANDBOX_CALLBACK_SECRET).toBe(ref.callbackSecret);
        expect(envMap.PROVENANCE_WATCH_DIRS).toBe("/an-1");
        expect(envMap.R_LIBS_SITE).toContain("/mnt/libs/current/r/");
        // The thread pools default to one thread, and the worker counts follow
        // the cpu request. The agent raises a pool per command.
        expect(envMap.OMP_NUM_THREADS).toBe("1");
        expect(envMap.OPENBLAS_NUM_THREADS).toBe("1");
        expect(envMap.BIOCPARALLEL_WORKER_NUMBER).toBe("2");
        expect(envMap.MC_CORES).toBeUndefined();

        expect(container.workingDir).toBe("/an-1/runs/run-1/step-a");

        expect(container.resources!.requests!.cpu).toBe("2");
        expect(container.resources!.requests!.memory).toBe("4Gi");
        expect(container.resources!.limits!.cpu).toBe("2");
        expect(container.resources!.limits!.memory).toBe("4Gi");

        const sessionVolume = podSpec.volumes!.find((v) => v.name === "session");
        expect(sessionVolume!.persistentVolumeClaim!.claimName).toBe("cortex-sessions");
        expect(podSpec.volumes!.map((v) => v.name)).toEqual(["session", "libs", "refs"]);

        const mounts = container.volumeMounts!;
        const ro = mounts.find((m) => m.name === "session" && m.mountPath === "/an-1")!;
        expect(ro.subPath).toBe("an-1");
        expect(ro.readOnly).toBe(true);

        const rw = mounts.find((m) => m.name === "session" && m.mountPath === "/an-1/runs/run-1/step-a")!;
        expect(rw.subPath).toBe("an-1/runs/run-1/step-a");
        expect(rw.readOnly).toBe(false);

        const libs = mounts.find((m) => m.name === "libs")!;
        expect(libs.mountPath).toBe("/mnt/libs");
        expect(libs.readOnly).toBe(true);

        expect(registered).toEqual([ref.sandboxId]);
    });

    test("session subPaths follow the resolved workspace root, not the analysis id", async () => {
        const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.9" }, metadata: { name: "sbx-nested" } }]);

        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            // An embedder whose roots are NOT `{pvcRoot}/{analysisId}`. The pod must mount the
            // directory the harness pre-creates under this root, not a same-named sibling of it.
            resolveWorkspaceRoot: (id) => `${SESSION_PVC_ROOT}/tenants/acme/${id}`,
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                { runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 1, memoryGb: 1 } },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        const container = stub.createdJobs[0]!.spec!.template.spec!.containers[0]!;
        const mounts = container.volumeMounts!;

        // Container-side paths are unchanged — the sandbox contract does not know where the tree lives.
        expect(container.workingDir).toBe("/an-1/runs/run-1/step-a");
        expect(mounts.find((m) => m.name === "session" && m.mountPath === "/an-1")!.subPath).toBe("tenants/acme/an-1");
        expect(mounts.find((m) => m.name === "session" && m.mountPath === "/an-1/runs/run-1/step-a")!.subPath).toBe("tenants/acme/an-1/runs/run-1/step-a");
    });

    test("mounts a declared write tail in place of the step directory", async () => {
        const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.7" }, metadata: { name: "sbx-tail" } }]);

        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot: (id) => `${SESSION_PVC_ROOT}/${id}`,
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                {
                    runId: "derive-table",
                    stepId: "derive",
                    analysisId: "an-1",
                    childWorkflowId: "derive-table:x",
                    resources: { cpu: 1, memoryGb: 1 },
                    writableTail: "report-sessions/thread-1/derived",
                },
                mintSandboxIdentity("derive-table"),
            )
        )._unsafeUnwrap();

        const container = stub.createdJobs[0]!.spec!.template.spec!.containers[0]!;
        const mounts = container.volumeMounts!.filter((m) => m.name === "session");

        expect(container.workingDir).toBe("/an-1/report-sessions/thread-1/derived");
        // The tree stays read-only, and the one read-write mount covers the declared tail alone.
        expect(mounts.find((m) => m.mountPath === "/an-1")!.readOnly).toBe(true);
        const rw = mounts.find((m) => m.mountPath === "/an-1/report-sessions/thread-1/derived")!;
        expect(rw.subPath).toBe("an-1/report-sessions/thread-1/derived");
        expect(rw.readOnly).toBe(false);
        // No step directory of the coordinates reaches a mount.
        expect(mounts.some((m) => m.mountPath.includes("runs/derive-table"))).toBe(false);
        expect(mounts).toHaveLength(2);
    });

    test("a workspace root outside sessionPvcRoot is a loud failure, not a silently wrong mount", async () => {
        const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.9" }, metadata: { name: "sbx-escape" } }]);

        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot: () => "/elsewhere/an-1",
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });

        // The throw escapes as a rejection rather than an `err` — `createSandbox` runs inside a
        // DBOS workflow body, where only a throw records the step as durably failed.
        const attempt = async () =>
            ops.createSandbox(
                { runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 1, memoryGb: 1 } },
                mintSandboxIdentity("run-1"),
            );
        await expect(attempt()).rejects.toThrow(/does not live under sessionPvcRoot/);
    });

    test("poll mode (default) omits CORTEX_BASE_URL — the pod spec documents that the sandbox never dials out", async () => {
        const stub = stubApis([
            {
                status: { phase: "Running", podIP: "10.0.0.3" },
                metadata: { name: "sbx-poll" },
            },
        ]);

        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://cortex.example.com:443",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });

        const ref = (
            await ops.createSandbox(
                {
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 1, memoryGb: 2 },
                },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        const container = stub.createdJobs[0]!.spec!.template.spec!.containers[0];
        const envMap = Object.fromEntries((container.env ?? []).map((e) => [e.name, e.value]));
        expect(envMap.SANDBOX_TRANSPORT).toBe("poll");
        expect(envMap.CORTEX_BASE_URL).toBeUndefined();
        expect(envMap.SANDBOX_CALLBACK_SECRET).toBe(ref.callbackSecret);
    });

    test("readOnly omits the rw volumeMount and pins workingDir to the RO tree", async () => {
        const stub = stubApis([
            {
                status: { phase: "Running", podIP: "10.0.0.2" },
                metadata: { name: "sbx-eph" },
            },
        ]);

        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            libStorePvc: "cortex-libs",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                {
                    runId: "ephemeral",
                    stepId: "ephemeral",
                    analysisId: "an-1",
                    childWorkflowId: "ephemeral:x",
                    resources: { cpu: 2, memoryGb: 4 },
                    readOnly: true,
                },
                mintSandboxIdentity("ephemeral"),
            )
        )._unsafeUnwrap();

        const podSpec = stub.createdJobs[0]!.spec!.template.spec!;
        const container = podSpec.containers[0];
        expect(container.workingDir).toBe("/an-1");

        const sessionMounts = container.volumeMounts!.filter((m) => m.name === "session");
        expect(sessionMounts).toHaveLength(1);
        expect(sessionMounts[0]!.readOnly).toBe(true);
        expect(sessionMounts[0]!.mountPath).toBe("/an-1");
        // No writable session mount exists.
        expect(container.volumeMounts!.some((m) => m.name === "session" && m.readOnly === false)).toBe(false);
    });

    test("node selector, tolerations, and runtimeClass thread onto the pod spec", async () => {
        const stub = stubApis([
            {
                status: { phase: "Running", podIP: "10.0.0.3" },
                metadata: { name: "sbx-z" },
            },
        ]);

        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            nodeSelector: { "platform.io/role": "agent-node" },
            tolerations: [
                {
                    key: "platform.io/agent-only",
                    operator: "Exists",
                    effect: "NoSchedule",
                },
            ],
            runtimeClassName: "gvisor",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                {
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        const podSpec = stub.createdJobs[0]!.spec!.template.spec!;
        expect(podSpec.nodeSelector).toEqual({ "platform.io/role": "agent-node" });
        expect(podSpec.tolerations).toEqual([
            {
                key: "platform.io/agent-only",
                operator: "Exists",
                effect: "NoSchedule",
            },
        ]);
        expect(podSpec.runtimeClassName).toBe("gvisor");
    });

    test("scheduling fields absent when config omits them", async () => {
        const stub = stubApis([
            {
                status: { phase: "Running", podIP: "10.0.0.4" },
                metadata: { name: "sbx-w" },
            },
        ]);

        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                {
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        const podSpec = stub.createdJobs[0]!.spec!.template.spec!;
        expect(podSpec.nodeSelector).toBeUndefined();
        expect(podSpec.tolerations).toBeUndefined();
        expect(podSpec.runtimeClassName).toBeUndefined();
    });

    test("lib/ref PVCs unset → no /mnt mounts and no lib-store env", async () => {
        const stub = stubApis([
            {
                status: { phase: "Running", podIP: "10.0.0.2" },
                metadata: { name: "sbx-y" },
            },
        ]);

        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                {
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        const podSpec = stub.createdJobs[0]!.spec!.template.spec!;
        expect(podSpec.volumes!.map((v) => v.name)).toEqual(["session"]);
        const mounts = podSpec.containers[0].volumeMounts!;
        expect(mounts.some((m) => m.mountPath.startsWith("/mnt"))).toBe(false);
        const env = podSpec.containers[0].env ?? [];
        const envMap = Object.fromEntries(env.map((e) => [e.name, e.value]));
        expect(envMap.R_LIBS_SITE).toBeUndefined();
        expect(envMap.PROVENANCE_WATCH_DIRS).toBe("/an-1");
    });
});

describe("k8s host-side lock gate (libStorePvcRoot)", () => {
    // With the root set, the backend proves the `inflexa.lock` of the farm
    // itself — the spec scenario "A host-readable volume root restores the
    // backend gate". The degrade mirrors Docker: the store mounts drop, and
    // the Job is still made.
    async function createWithRoot(root: string) {
        const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.9" }, metadata: { name: "sbx-x-abc" } }]);
        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://cortex.example.com:443",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            libStorePvc: "cortex-libs",
            libStorePvcRoot: root,
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });
        (
            await ops.createSandbox(
                {
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();
        return stub.createdJobs[0]!.spec!.template.spec!;
    }

    test("a farm with no usable lock drops the store mounts, and the Job is still made", async () => {
        const root = mkdtempSync(join(tmpdir(), "k8s-libs-root-"));
        try {
            const podSpec = await createWithRoot(root);

            expect(podSpec.volumes!.map((v) => v.name)).toEqual(["session"]);
            const env = Object.fromEntries((podSpec.containers[0]!.env ?? []).map((e) => [e.name, e.value]));
            expect(env.R_LIBS_SITE).toBeUndefined();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a required package store refuses a farm with no lock, and no Job is made", async () => {
        const root = mkdtempSync(join(tmpdir(), "k8s-libs-root-"));
        try {
            const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.9" }, metadata: { name: "sbx-x-abc" } }]);
            const ops = createK8sSandboxOps({
                image: "sandbox-base:latest",
                cortexBaseUrl: "https://cortex.example.com:443",
                namespace: "sandbox",
                farmSource: FIXED_FARM,
                sessionPvcRoot: SESSION_PVC_ROOT,
                resolveWorkspaceRoot,
                sessionPvc: "cortex-sessions",
                libStorePvc: "cortex-libs",
                libStorePvcRoot: root,
                packageStore: "required",
                batchApi: stub.batchApi,
                coreApi: stub.coreApi,
                registerSandbox: async () => {},
            });

            const result = await ops.createSandbox(
                {
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                },
                mintSandboxIdentity("run-1"),
            );

            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
                expect(result.error.type).toBe("farm_unusable");
                if (result.error.type === "farm_unusable") {
                    expect(result.error.analysisId).toBe("an-1");
                    // The farm path stays PVC-relative; the lock path is the joined one.
                    expect(result.error.farmPath).toBe("farms/catalog");
                    expect(result.error.lockPath).toBe(join(root, "farms", "catalog", "inflexa.lock"));
                    expect(result.error.lockError).toBe("lock_unreadable");
                }
            }
            expect(stub.createdJobs).toHaveLength(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a parsable lock keeps the gate open, and the mounts land", async () => {
        const root = mkdtempSync(join(tmpdir(), "k8s-libs-root-"));
        try {
            mkdirSync(join(root, "farms", "catalog"), { recursive: true });
            writeFileSync(join(root, "farms", "catalog", "inflexa.lock"), JSON.stringify({ schema: 1, arch: "amd64", packages: [], languages: {} }));

            const podSpec = await createWithRoot(root);

            expect(podSpec.volumes!.map((v) => v.name)).toEqual(["session", "libs"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("k8s createSandbox failure cleanup", () => {
    test("deletes the Job when the pod fails to come up", async () => {
        // Pod phase Failed → waitForPodReady throws immediately.
        const stub = stubApis([{ status: { phase: "Failed" }, metadata: { name: "p" } }]);
        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });

        const result = await ops.createSandbox(
            {
                runId: "run-1",
                stepId: "step-a",
                analysisId: "an-1",
                childWorkflowId: "run-1-0",
                resources: { cpu: 2, memoryGb: 4 },
            },
            mintSandboxIdentity("run-1"),
        );
        expect(result.isErr()).toBe(true);
        const created = stub.createdJobs[0]!.metadata!.name!;
        expect(stub.deletedJobs).toEqual([created]);
    });

    test("deletes the Job when registerSandbox throws", async () => {
        const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.9" }, metadata: { name: "p" } }]);
        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {
                throw new Error("registry write failed");
            },
        });

        const result = await ops.createSandbox(
            {
                runId: "run-1",
                stepId: "step-a",
                analysisId: "an-1",
                childWorkflowId: "run-1-0",
                resources: { cpu: 2, memoryGb: 4 },
            },
            mintSandboxIdentity("run-1"),
        );
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.type).toBe("container_create_failed");
        }
        const created = stub.createdJobs[0]!.metadata!.name!;
        expect(stub.deletedJobs).toEqual([created]);
    });
});

describe("k8s createSandbox adoption (recovery re-run)", () => {
    test("adopts a live Job on 409 instead of leaking a second machine", async () => {
        // createNamespacedJob 409s once (the machine already exists from the
        // pre-crash attempt); its pod is Running → adopt as-is.
        const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.7" }, metadata: { name: "p" } }], { create409Times: 1 });
        const registered: string[] = [];
        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async (_meta, ref) => {
                registered.push(ref.sandboxId);
            },
        });

        const ref = (
            await ops.createSandbox(
                {
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        expect(ref.host).toBe("10.0.0.7");
        // No Job created (the sole attempt 409'd) and the live pod was not deleted.
        expect(stub.createdJobs).toHaveLength(0);
        expect(stub.deletedJobs).toEqual([]);
        expect(registered).toEqual([ref.sandboxId]);
    });

    test("on 409 with a terminal prior pod, deletes and recreates fresh", async () => {
        // Pod #1 (terminal check) Failed → dead prior attempt; pod #2 (ready wait)
        // Running → the recreated machine.
        const stub = stubApis(
            [
                { status: { phase: "Failed" }, metadata: { name: "p" } },
                { status: { phase: "Running", podIP: "10.0.0.8" }, metadata: { name: "p" } },
            ],
            { create409Times: 1 },
        );
        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });

        const ref = (
            await ops.createSandbox(
                {
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        expect(ref.host).toBe("10.0.0.8");
        expect(stub.deletedJobs).toHaveLength(1); // dead prior Job removed
        expect(stub.createdJobs).toHaveLength(1); // recreated after the name freed
    });

    test("refuses to adopt a name collision owned by a different workflow", async () => {
        // 409, but the existing Job belongs to a *different* step — never adopt or
        // delete it.
        const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.9" }, metadata: { name: "p" } }], {
            create409Times: 1,
            existingOwner: "some-other-wf-3",
        });
        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });

        const result = await ops.createSandbox(
            {
                runId: "run-1",
                stepId: "step-a",
                analysisId: "an-1",
                childWorkflowId: "run-1-0",
                resources: { cpu: 2, memoryGb: 4 },
            },
            mintSandboxIdentity("run-1"),
        );
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.type).toBe("name_conflict");
        }
        expect(stub.deletedJobs).toEqual([]); // sibling's Job untouched
    });
});

describe("k8s job ownership labels", () => {
    test("stamps owner-workflow-id, run-id, and step-id labels for the reaper", async () => {
        const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.1" }, metadata: { name: "p" } }]);
        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                {
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        const meta = stub.createdJobs[0]!.metadata!;
        expect(meta.labels!["app.kubernetes.io/managed-by"]).toBe("cortex");
        expect(meta.annotations!["cortex/owner-workflow-id"]).toBe("run-1-0");
        expect(meta.labels!["cortex/run-id"]).toBe("run-1");
        expect(meta.labels!["cortex/step-id"]).toBe("step-a");
    });

    test("an owner id that no label could hold round-trips through listManagedSandboxes", async () => {
        // The production data-profile id: `dataprofile:{analysisUUID}:{nonceUUID}`,
        // 85 bytes with colons — over the 63-byte label cap and outside the label
        // charset twice over. It is a real DBOS workflow id, so what comes back out
        // has to be usable as a `getWorkflowStatus` key, byte for byte.
        const childWorkflowId = "dataprofile:01a01372-a1bd-73d6-8dd2-9dc7cb84aa2e:0f3c1d2e-4b5a-6c7d-8e9f-a0b1c2d3e4f5";
        expect(childWorkflowId.length).toBeGreaterThan(63);

        const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.1" }, metadata: { name: "p" } }]);
        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                { runId: "data-profile", stepId: "profile", analysisId: "an-1", childWorkflowId, resources: { cpu: 2, memoryGb: 4 } },
                mintSandboxIdentity("data-profile"),
            )
        )._unsafeUnwrap();

        const managed = (await ops.listManagedSandboxes())._unsafeUnwrap();
        expect(managed[0]!.ownerWorkflowId).toBe(childWorkflowId);

        // The id lives in the annotation precisely because no label could hold it:
        // every label value on the Job still has to be admissible or the API server
        // rejects the whole thing.
        for (const value of Object.values(stub.createdJobs[0]!.metadata!.labels!)) {
            expect(value).toMatch(/^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/);
            expect(value.length).toBeLessThanOrEqual(63);
        }
    });

    test("a Job recording no owner reports none rather than guessing", async () => {
        const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.1" }, metadata: { name: "p" } }]);
        stub.createdJobs.push({
            metadata: {
                name: "sbx-ownerless",
                labels: { "cortex/sandbox-id": "sbx-ownerless" },
                creationTimestamp: new Date(1_700_000_000_000),
            },
        } as V1Job);

        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });

        const managed = (await ops.listManagedSandboxes())._unsafeUnwrap();
        expect(managed).toEqual([{ sandboxId: "sbx-ownerless", ownerWorkflowId: null, createdAtMs: 1_700_000_000_000 }]);
    });
});

describe("sanitizeLabelValue", () => {
    test("rewrites invalid chars, trims to alnum boundaries, and caps at 63", () => {
        expect(sanitizeLabelValue("run-1-0")).toBe("run-1-0");
        expect(sanitizeLabelValue("a:b/c")).toBe("a-b-c");
        expect(sanitizeLabelValue(":lead-and-trail:")).toBe("lead-and-trail");
        const long = "x".repeat(80);
        expect(sanitizeLabelValue(long).length).toBe(63);
    });

    test("UUIDs pass through unaltered and trailing non-alnum is trimmed after the cap", () => {
        const uuid = "2f9c1f6e-9f4b-4c1e-8a3d-0b1c2d3e4f5a";
        expect(sanitizeLabelValue(uuid)).toBe(uuid);
        // 62 alnum chars + "-" at position 63: the cap keeps the dash, the tail trim removes it.
        expect(sanitizeLabelValue(`${"x".repeat(62)}-tail`)).toBe("x".repeat(62));
        expect(sanitizeLabelValue("---")).toBe("");
    });
});

describe("k8s host-supplied pod labels", () => {
    const READY_POD = [
        {
            status: { phase: "Running" as const, podIP: "10.0.0.1" },
            metadata: { name: "sbx-x-abc" },
        },
    ];

    function opsWith(stub: ReturnType<typeof stubApis>) {
        return createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://cortex.internal:443",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });
    }

    test("host labels reach the pod template and the Job metadata, beside the harness's own", async () => {
        // The pod template is the placement that a cost reconciler allocates on;
        // a Job-only label never reaches it.
        const stub = stubApis(READY_POD);
        (
            await opsWith(stub).createSandbox(
                {
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                    podLabels: { "cortex/billing-context": "bc-123", "cortex/user-id": "user-9" },
                },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        const job = stub.createdJobs[0]!;
        for (const labels of [job.metadata!.labels!, job.spec!.template.metadata!.labels!]) {
            expect(labels["cortex/billing-context"]).toBe("bc-123");
            expect(labels["cortex/user-id"]).toBe("user-9");
            expect(labels["cortex/analysis-id"]).toBe("an-1");
            expect(labels["cortex/run-id"]).toBe("run-1");
        }
    });

    test("host label values are sanitized, because one invalid value loses the whole Job", async () => {
        const stub = stubApis(READY_POD);
        (
            await opsWith(stub).createSandbox(
                {
                    runId: "data-profile",
                    stepId: "profile",
                    analysisId: "an-1",
                    childWorkflowId: "data-profile:x",
                    resources: { cpu: 1, memoryGb: 1 },
                    podLabels: { "cortex/billing-context": "bc:123", "cortex/user-id": "user@example.com" },
                },
                mintSandboxIdentity("data-profile"),
            )
        )._unsafeUnwrap();

        const podLabels = stub.createdJobs[0]!.spec!.template.metadata!.labels!;
        expect(podLabels["cortex/billing-context"]).toBe("bc-123");
        expect(podLabels["cortex/user-id"]).toBe("user-example.com");
        expect(podLabels["cortex/run-id"]).toBe("data-profile");
    });

    test("an arbitrary host key is stamped verbatim — the harness reads no key", async () => {
        const stub = stubApis(READY_POD);
        (
            await opsWith(stub).createSandbox(
                {
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                    podLabels: { "example.com/tenant": "acme" },
                },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        expect(stub.createdJobs[0]!.spec!.template.metadata!.labels!["example.com/tenant"]).toBe("acme");
    });

    test("absent pod labels stamp nothing extra and still spawn", async () => {
        const stub = stubApis(READY_POD);
        const ref = (
            await opsWith(stub).createSandbox(
                {
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        expect(ref.host).toBe("10.0.0.1");
        for (const labels of [stub.createdJobs[0]!.metadata!.labels!, stub.createdJobs[0]!.spec!.template.metadata!.labels!]) {
            expect(labels["cortex/billing-context"]).toBeUndefined();
            expect(labels["cortex/user-id"]).toBeUndefined();
            // The two identifiers the harness holds itself stay on both.
            expect(labels["cortex/analysis-id"]).toBe("an-1");
            expect(labels["cortex/run-id"]).toBe("run-1");
        }
    });
});

describe("k8s teardown", () => {
    test("404 on delete is idempotent success", async () => {
        const stub = stubApis([]);
        stub.setDeleteError({ code: 404 });
        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });
        const result = await ops.teardown({
            sandboxId: "sbx-missing",
            host: "h",
            port: 1,
            backend: "k8s",
            callbackSecret: "x",
        });
        expect(result.isOk()).toBe(true);
    });

    test("non-404 errors propagate", async () => {
        const stub = stubApis([]);
        stub.setDeleteError({ code: 500 });
        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });
        const result = await ops.teardown({
            sandboxId: "sbx-x",
            host: "h",
            port: 1,
            backend: "k8s",
            callbackSecret: "x",
        });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.type).toBe("teardown_failed");
        }
    });
});

describe("k8s isAlive", () => {
    test("Pending / Running → true; Succeeded / Failed → false; missing → false", async () => {
        const states: Array<{ phase: string | undefined; expected: boolean }> = [
            { phase: "Running", expected: true },
            { phase: "Pending", expected: true },
            { phase: "Succeeded", expected: false },
            { phase: "Failed", expected: false },
            { phase: undefined, expected: false },
        ];

        for (const { phase, expected } of states) {
            const stub = stubApis(
                phase === undefined
                    ? []
                    : [
                          {
                              status: { phase },
                              metadata: { name: "p" },
                          },
                      ],
            );
            const ops = createK8sSandboxOps({
                image: "sandbox-base:latest",
                cortexBaseUrl: "https://x",
                namespace: "sandbox",
                farmSource: FIXED_FARM,
                sessionPvcRoot: SESSION_PVC_ROOT,
                resolveWorkspaceRoot,
                batchApi: stub.batchApi,
                coreApi: stub.coreApi,
                registerSandbox: async () => {},
            });
            const liveness = (
                await ops.isAlive({
                    sandboxId: "sbx-x",
                    host: "h",
                    port: 1,
                    backend: "k8s",
                    callbackSecret: "x",
                })
            )._unsafeUnwrap();
            expect(liveness.alive).toBe(expected);
            expect(liveness.oomKilled).toBe(false);
        }
    });

    test("Failed pod with an OOMKilled container reports the OOM cause", async () => {
        const stub = stubApis([
            {
                status: {
                    phase: "Failed",
                    containerStatuses: [{ state: { terminated: { reason: "OOMKilled" } } }],
                },
                metadata: { name: "p" },
            },
        ]);
        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });
        const liveness = (
            await ops.isAlive({
                sandboxId: "sbx-oom",
                host: "h",
                port: 1,
                backend: "k8s",
                callbackSecret: "x",
            })
        )._unsafeUnwrap();
        expect(liveness).toEqual({ alive: false, oomKilled: true });
    });
});

describe("k8s createSandbox — the farm mounts", () => {
    const META = { runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 1, memoryGb: 1 } } as const;

    function opsWith(farmSource: FarmSource, stub: ReturnType<typeof stubApis>, toolchainSource?: "image" | "store") {
        return createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            farmSource,
            toolchainSource,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            libStorePvc: "cortex-libs",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });
    }

    test("the farm mounts as a read-only subPath of the libs PVC, after the store mount", async () => {
        const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.2" }, metadata: { name: "sbx-f" } }]);

        (await opsWith(FIXED_FARM, stub).createSandbox(META, mintSandboxIdentity("run-1")))._unsafeUnwrap();

        const container = stub.createdJobs[0]!.spec!.template.spec!.containers[0]!;
        const mounts = container.volumeMounts!.filter((m) => m.name === "libs");
        expect(mounts.map((m) => ({ mountPath: m.mountPath, subPath: m.subPath, readOnly: m.readOnly }))).toEqual([
            { mountPath: "/mnt/libs", subPath: undefined, readOnly: true },
            { mountPath: "/mnt/libs/current", subPath: "farms/catalog", readOnly: true },
        ]);
    });

    test("a cache location mounts read-write at /mnt/libs/cache through the same claim", async () => {
        const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.3" }, metadata: { name: "sbx-c" } }]);
        const source: FarmSource = { kind: "fixed", location: { farmPath: "farms/an-1", cachePath: "caches/an-1" } };

        (await opsWith(source, stub, "image").createSandbox(META, mintSandboxIdentity("run-1")))._unsafeUnwrap();

        const podSpec = stub.createdJobs[0]!.spec!.template.spec!;
        const libsVolume = podSpec.volumes!.find((v) => v.name === "libs")!;
        // The claim carries no volume-level readOnly when the cache writes
        // through it — the per-mount flags keep the store and the farm read-only.
        expect(libsVolume.persistentVolumeClaim!.readOnly).toBeUndefined();

        const mounts = podSpec.containers[0]!.volumeMounts!.filter((m) => m.name === "libs");
        expect(mounts.map((m) => ({ mountPath: m.mountPath, subPath: m.subPath, readOnly: m.readOnly }))).toEqual([
            { mountPath: "/mnt/libs", subPath: undefined, readOnly: true },
            { mountPath: "/mnt/libs/farm", subPath: "farms/an-1", readOnly: true },
            { mountPath: "/mnt/libs/cache", subPath: "caches/an-1", readOnly: false },
        ]);
    });

    test("a resolver refusal returns farm_unavailable and creates no Job", async () => {
        const stub = stubApis([]);
        const source: FarmSource = { kind: "per-analysis", resolve: async () => ({ kind: "unavailable", reason: "no store yet" }) };

        const result = await opsWith(source, stub).createSandbox(META, mintSandboxIdentity("run-1"));

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.type).toBe("farm_unavailable");
            if (result.error.type === "farm_unavailable") expect(result.error.reason).toBe("no store yet");
        }
        expect(stub.createdJobs).toHaveLength(0);
    });

    test("an absolute farm path is refused before any Job is made", async () => {
        const stub = stubApis([]);
        const source: FarmSource = { kind: "fixed", location: { farmPath: "/mnt/libs/farms/x" } };

        const attempt = async (): Promise<void> => {
            (await opsWith(source, stub).createSandbox(META, mintSandboxIdentity("run-1")))._unsafeUnwrap();
        };
        await expect(attempt()).rejects.toThrow(/PVC-relative/);
        expect(stub.createdJobs).toHaveLength(0);
    });
});
