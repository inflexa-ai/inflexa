// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the DNS-1123 subdomain grammar that an ownership label value must obey, whose shape is a pattern
const DNS_SUBDOMAIN = /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;

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
import type { V1Job, V1Pod } from "@kubernetes/client-node";

import { createCapturingLogger } from "../../__tests__/setup/logger.js";
import { createK8sSandboxOps, waitForPodReady, type BatchJobApi, type CorePodApi } from "../k8s-client.js";
import { mintSandboxIdentity } from "../identity.js";
import type { FarmSource } from "../types.js";
import { splitSpawn } from "../__fixtures__/spawn.js";
import { presentAt, presentFind } from "../../lib/present.js";

/** The conventional managed layout: workspace roots sit directly under the PVC mountpoint. */
const SESSION_PVC_ROOT = "/sessions";
const resolveWorkspaceRoot = (analysisId: string) => Promise.resolve(`${SESSION_PVC_ROOT}/${analysisId}`);

/** The managed shape: one farm location, PVC-relative, for every analysis. */
const FIXED_FARM: FarmSource = { kind: "fixed", location: { farmPath: "farms/catalog" } };

function stubApis(podSequence: V1Pod[], opts: { create409Times?: number; existingOwner?: string } = {}) {
    const createdJobs: V1Job[] = [];
    const deletedJobs: string[] = [];
    let podIdx = 0;
    let deletedError: { code: number } | null = null;
    let pending409 = opts.create409Times ?? 0;
    let existingDeleted = false;
    const existingOwner = opts.existingOwner ?? "run-1-0";

    const batchApi: BatchJobApi = {
        createNamespacedJob: ({ body }: { namespace: string; body: V1Job }) => {
            if (pending409 > 0) {
                pending409--;
                // Mirror `@kubernetes/client-node` `ApiException`: status on `.code`.
                return Promise.reject(Object.assign(new Error("jobs.batch already exists"), { code: 409 }));
            }
            createdJobs.push(body);
            return Promise.resolve({ metadata: { name: body.metadata?.name, uid: "job-uid-1" } });
        },
        deleteNamespacedJob: ({ name }: { namespace: string; name: string }) => {
            // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the double rejects the scripted delete failure in the exact shape the client carries, and the test matches on it.
            if (deletedError) return Promise.reject(deletedError);
            existingDeleted = true;
            deletedJobs.push(name);
            return Promise.resolve();
        },
        listNamespacedJob: (_args: { namespace: string; labelSelector?: string }) => Promise.resolve({ items: createdJobs }),
        readNamespacedJob: ({ name }: { namespace: string; name: string }) => {
            if (existingDeleted) {
                return Promise.reject(Object.assign(new Error("not found"), { code: 404 }));
            }
            return Promise.resolve({ metadata: { name, uid: "job-uid-existing", annotations: { "cortex/owner-workflow-id": existingOwner } } });
        },
    };

    const coreApi: CorePodApi = {
        listNamespacedPod: (_args: { namespace: string; labelSelector?: string }) => {
            const pod = podSequence[Math.min(podIdx, podSequence.length - 1)];
            podIdx++;
            return Promise.resolve({ items: pod ? [pod] : [] });
        },
    };

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
    test("creates a Job with no egress target", async () => {
        const stub = stubApis([
            {
                status: { phase: "Running", podIP: "10.0.0.1" },
                metadata: { name: "sbx-x-abc" },
            },
        ]);
        const registered: string[] = [];

        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            libStorePvc: "cortex-libs",
            refStorePvc: "cortex-refs",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: (_session, _spec, ref) => {
                registered.push(ref.sandboxId);

                return Promise.resolve();
            },
        });

        const ref = (
            await ops.createSandbox(
                ...splitSpawn({
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                }),
                mintSandboxIdentity("run-1"),
                {},
            )
        )._unsafeUnwrap();

        expect(ref.backend).toBe("k8s");
        expect(ref.host).toBe("10.0.0.1");
        expect(ref.port).toBe(8765);

        expect(stub.createdJobs).toHaveLength(1);
        const podSpec = presentAt(stub.createdJobs, 0).spec?.template.spec;
        if (podSpec === undefined) throw new Error("podSpec is absent");
        const container = podSpec.containers[0];
        if (container === undefined) throw new Error("the job pod holds no container");
        const env = container.env ?? [];
        const envMap = Object.fromEntries(env.map((e) => [e.name, e.value]));
        // The pod never dials out, thus it gets no address to dial.
        expect(envMap.SANDBOX_TRANSPORT).toBeUndefined();
        expect(envMap.CORTEX_BASE_URL).toBeUndefined();
        expect(envMap.PROVENANCE_WATCH_DIRS).toBe("/an-1");
        expect(envMap.R_LIBS_SITE).toContain("/mnt/libs/current/r/");
        // The thread pools default to one thread, and the worker counts follow
        // the cpu request. The agent raises a pool per command.
        expect(envMap.OMP_NUM_THREADS).toBe("1");
        expect(envMap.OPENBLAS_NUM_THREADS).toBe("1");
        expect(envMap.BIOCPARALLEL_WORKER_NUMBER).toBe("2");
        expect(envMap.MC_CORES).toBeUndefined();

        expect(container.workingDir).toBe("/an-1/runs/run-1/step-a");

        expect(container.resources?.requests?.cpu).toBe("2");
        expect(container.resources?.requests?.memory).toBe("4Gi");
        expect(container.resources?.limits?.cpu).toBe("2");
        expect(container.resources?.limits?.memory).toBe("4Gi");

        const volumes = podSpec.volumes;
        if (volumes === undefined) throw new Error("volumes is absent");
        const sessionVolume = volumes.find((v) => v.name === "session");
        expect(sessionVolume?.persistentVolumeClaim?.claimName).toBe("cortex-sessions");
        expect(podSpec.volumes?.map((v) => v.name)).toEqual(["session", "libs", "refs"]);

        const mounts = container.volumeMounts;
        if (mounts === undefined) throw new Error("mounts is absent");
        const ro = presentFind(mounts, (m) => m.name === "session" && m.mountPath === "/an-1");
        expect(ro.subPath).toBe("an-1");
        expect(ro.readOnly).toBe(true);

        const rw = presentFind(mounts, (m) => m.name === "session" && m.mountPath === "/an-1/runs/run-1/step-a");
        expect(rw.subPath).toBe("an-1/runs/run-1/step-a");
        expect(rw.readOnly).toBe(false);

        const libs = presentFind(mounts, (m) => m.name === "libs");
        expect(libs.mountPath).toBe("/mnt/libs");
        expect(libs.readOnly).toBe(true);

        expect(registered).toEqual([ref.sandboxId]);
    });

    test("session subPaths follow the resolved workspace root, not the analysis id", async () => {
        const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.9" }, metadata: { name: "sbx-nested" } }]);

        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            // An embedder whose roots are NOT `{pvcRoot}/{analysisId}`. The pod must mount the
            // directory the harness pre-creates under this root, not a same-named sibling of it.
            resolveWorkspaceRoot: (id) => Promise.resolve(`${SESSION_PVC_ROOT}/tenants/acme/${id}`),
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                ...splitSpawn({ runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 1, memoryGb: 1 } }),
                mintSandboxIdentity("run-1"),
                {},
            )
        )._unsafeUnwrap();

        const container = presentAt(stub.createdJobs, 0).spec?.template.spec?.containers[0];
        if (container === undefined) throw new Error("container is absent");
        const mounts = container.volumeMounts;
        if (mounts === undefined) throw new Error("mounts is absent");

        // Container-side paths are unchanged — the sandbox contract does not know where the tree lives.
        expect(container.workingDir).toBe("/an-1/runs/run-1/step-a");
        expect(presentFind(mounts, (m) => m.name === "session" && m.mountPath === "/an-1").subPath).toBe("tenants/acme/an-1");
        expect(presentFind(mounts, (m) => m.name === "session" && m.mountPath === "/an-1/runs/run-1/step-a").subPath).toBe(
            "tenants/acme/an-1/runs/run-1/step-a",
        );
    });

    test("mounts a declared write tail in place of the step directory", async () => {
        const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.7" }, metadata: { name: "sbx-tail" } }]);

        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot: (id) => Promise.resolve(`${SESSION_PVC_ROOT}/${id}`),
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                ...splitSpawn({
                    runId: "derive-table",
                    stepId: "derive",
                    analysisId: "an-1",
                    childWorkflowId: "derive-table:x",
                    resources: { cpu: 1, memoryGb: 1 },
                    writableTail: "report-sessions/thread-1/derived",
                }),
                mintSandboxIdentity("derive-table"),
                {},
            )
        )._unsafeUnwrap();

        const container = presentAt(stub.createdJobs, 0).spec?.template.spec?.containers[0];
        if (container === undefined) throw new Error("container is absent");
        const allMounts = container.volumeMounts;
        if (allMounts === undefined) throw new Error("volumeMounts is absent");
        const mounts = allMounts.filter((m) => m.name === "session");

        expect(container.workingDir).toBe("/an-1/report-sessions/thread-1/derived");
        // The tree stays read-only, and the one read-write mount covers the declared tail alone.
        expect(presentFind(mounts, (m) => m.mountPath === "/an-1").readOnly).toBe(true);
        const rw = presentFind(mounts, (m) => m.mountPath === "/an-1/report-sessions/thread-1/derived");
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
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot: () => Promise.resolve("/elsewhere/an-1"),
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });

        // The throw escapes as a rejection rather than an `err` — `createSandbox` runs inside a
        // DBOS workflow body, where only a throw records the step as durably failed.
        const attempt = async () =>
            ops.createSandbox(
                ...splitSpawn({ runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 1, memoryGb: 1 } }),
                mintSandboxIdentity("run-1"),
                {},
            );
        await expect(attempt()).rejects.toThrow("does not live under sessionPvcRoot");
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
                ...splitSpawn({
                    runId: "ephemeral",
                    stepId: "ephemeral",
                    analysisId: "an-1",
                    childWorkflowId: "ephemeral:x",
                    resources: { cpu: 2, memoryGb: 4 },
                    readOnly: true,
                }),
                mintSandboxIdentity("ephemeral"),
                {},
            )
        )._unsafeUnwrap();

        const podSpec = presentAt(stub.createdJobs, 0).spec?.template.spec;
        if (podSpec === undefined) throw new Error("podSpec is absent");
        const container = podSpec.containers[0];
        if (container === undefined) throw new Error("the job pod holds no container");
        expect(container.workingDir).toBe("/an-1");

        const jobMounts = container.volumeMounts;
        if (jobMounts === undefined) throw new Error("volumeMounts is absent");
        const sessionMounts = jobMounts.filter((m) => m.name === "session");
        expect(sessionMounts).toHaveLength(1);
        expect(presentAt(sessionMounts, 0).readOnly).toBe(true);
        expect(presentAt(sessionMounts, 0).mountPath).toBe("/an-1");
        // No writable session mount exists.
        expect(container.volumeMounts?.some((m) => m.name === "session" && m.readOnly === false)).toBe(false);
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
                ...splitSpawn({
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                }),
                mintSandboxIdentity("run-1"),
                {},
            )
        )._unsafeUnwrap();

        const podSpec = presentAt(stub.createdJobs, 0).spec?.template.spec;
        if (podSpec === undefined) throw new Error("podSpec is absent");
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
                ...splitSpawn({
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                }),
                mintSandboxIdentity("run-1"),
                {},
            )
        )._unsafeUnwrap();

        const podSpec = presentAt(stub.createdJobs, 0).spec?.template.spec;
        if (podSpec === undefined) throw new Error("podSpec is absent");
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
                ...splitSpawn({
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                }),
                mintSandboxIdentity("run-1"),
                {},
            )
        )._unsafeUnwrap();

        const podSpec = presentAt(stub.createdJobs, 0).spec?.template.spec;
        if (podSpec === undefined) throw new Error("podSpec is absent");
        expect(podSpec.volumes?.map((v) => v.name)).toEqual(["session"]);
        const container = podSpec.containers[0];
        if (container === undefined) throw new Error("the job pod holds no container");
        const mounts = container.volumeMounts;
        if (mounts === undefined) throw new Error("mounts is absent");
        expect(mounts.some((m) => m.mountPath.startsWith("/mnt"))).toBe(false);
        const env = container.env ?? [];
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
                ...splitSpawn({
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                }),
                mintSandboxIdentity("run-1"),
                {},
            )
        )._unsafeUnwrap();
        const podSpec = presentAt(stub.createdJobs, 0).spec?.template.spec;
        if (podSpec === undefined) throw new Error("podSpec is absent");
        return podSpec;
    }

    test("a farm with no usable lock drops the store mounts, and the Job is still made", async () => {
        const root = mkdtempSync(join(tmpdir(), "k8s-libs-root-"));
        try {
            const podSpec = await createWithRoot(root);

            expect(podSpec.volumes?.map((v) => v.name)).toEqual(["session"]);
            const env = Object.fromEntries((presentAt(podSpec.containers, 0).env ?? []).map((e) => [e.name, e.value]));
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
                ...splitSpawn({
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                }),
                mintSandboxIdentity("run-1"),
                {},
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

            expect(podSpec.volumes?.map((v) => v.name)).toEqual(["session", "libs"]);
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
            ...splitSpawn({
                runId: "run-1",
                stepId: "step-a",
                analysisId: "an-1",
                childWorkflowId: "run-1-0",
                resources: { cpu: 2, memoryGb: 4 },
            }),
            mintSandboxIdentity("run-1"),
            {},
        );
        expect(result.isErr()).toBe(true);
        const created = presentAt(stub.createdJobs, 0).metadata?.name;
        if (created === undefined) throw new Error("created is absent");
        expect(stub.deletedJobs).toEqual([created]);
    });

    test("deletes the Job when registerSandbox throws", async () => {
        const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.9" }, metadata: { name: "p" } }]);
        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: () => {
                return Promise.reject(new Error("registry write failed"));
            },
        });

        const result = await ops.createSandbox(
            ...splitSpawn({
                runId: "run-1",
                stepId: "step-a",
                analysisId: "an-1",
                childWorkflowId: "run-1-0",
                resources: { cpu: 2, memoryGb: 4 },
            }),
            mintSandboxIdentity("run-1"),
            {},
        );
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.type).toBe("container_create_failed");
        }
        const created = presentAt(stub.createdJobs, 0).metadata?.name;
        if (created === undefined) throw new Error("created is absent");
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
            namespace: "sandbox",
            farmSource: FIXED_FARM,
            sessionPvcRoot: SESSION_PVC_ROOT,
            resolveWorkspaceRoot,
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: (_session, _spec, ref) => {
                registered.push(ref.sandboxId);

                return Promise.resolve();
            },
        });

        const ref = (
            await ops.createSandbox(
                ...splitSpawn({
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                }),
                mintSandboxIdentity("run-1"),
                {},
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
                ...splitSpawn({
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                }),
                mintSandboxIdentity("run-1"),
                {},
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
            ...splitSpawn({
                runId: "run-1",
                stepId: "step-a",
                analysisId: "an-1",
                childWorkflowId: "run-1-0",
                resources: { cpu: 2, memoryGb: 4 },
            }),
            mintSandboxIdentity("run-1"),
            {},
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
                ...splitSpawn({
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                }),
                mintSandboxIdentity("run-1"),
                {},
            )
        )._unsafeUnwrap();

        const meta = presentAt(stub.createdJobs, 0).metadata;
        if (meta === undefined) throw new Error("meta is absent");
        const labels = meta.labels;
        if (labels === undefined) throw new Error("labels is absent");
        const annotations = meta.annotations;
        if (annotations === undefined) throw new Error("annotations is absent");
        expect(labels["app.kubernetes.io/managed-by"]).toBe("cortex");
        expect(annotations["cortex/owner-workflow-id"]).toBe("run-1-0");
        expect(labels["cortex/run-id"]).toBe("run-1");
        expect(labels["cortex/step-id"]).toBe("step-a");
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
                ...splitSpawn({ runId: "data-profile", stepId: "profile", analysisId: "an-1", childWorkflowId, resources: { cpu: 2, memoryGb: 4 } }),
                mintSandboxIdentity("data-profile"),
                {},
            )
        )._unsafeUnwrap();

        const managed = (await ops.listManagedSandboxes())._unsafeUnwrap();
        expect(presentAt(managed, 0).ownerWorkflowId).toBe(childWorkflowId);

        // The id lives in the annotation precisely because no label could hold it:
        // every label value on the Job still has to be admissible or the API server
        // rejects the whole thing.
        const ownerJob = presentAt(stub.createdJobs, 0);
        const ownerLabels = ownerJob.metadata?.labels;
        if (ownerLabels === undefined) throw new Error("labels is absent");
        for (const value of Object.values(ownerLabels)) {
            expect(DNS_SUBDOMAIN.test(value)).toBe(true);
            expect(value.length).toBeLessThanOrEqual(63);
        }
    });

    test("a Job recording no owner reports none rather than guessing", async () => {
        const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.1" }, metadata: { name: "p" } }]);
        const job: V1Job = {
            metadata: {
                name: "sbx-ownerless",
                labels: { "cortex/sandbox-id": "sbx-ownerless" },
                creationTimestamp: new Date(1_700_000_000_000),
            },
        };
        stub.createdJobs.push(job);

        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
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

describe("k8s label set", () => {
    const READY_POD = [
        {
            status: { phase: "Running" as const, podIP: "10.0.0.1" },
            metadata: { name: "sbx-x-abc" },
        },
    ];

    function opsWith(stub: ReturnType<typeof stubApis>) {
        return createK8sSandboxOps({
            image: "sandbox-base:latest",
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

    const SPAWN = { runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 2, memoryGb: 4 } };

    test("the Job metadata and the pod template each carry the six harness labels from the session", async () => {
        const stub = stubApis(READY_POD);
        const identity = mintSandboxIdentity("run-1");
        (await opsWith(stub).createSandbox(...splitSpawn(SPAWN), identity, {}))._unsafeUnwrap();

        const job = presentAt(stub.createdJobs, 0);
        const expected = {
            "app.kubernetes.io/managed-by": "cortex",
            role: "sandbox",
            "cortex/sandbox-id": identity.sandboxId,
            "cortex/analysis-id": "an-1",
            "cortex/run-id": "run-1",
            "cortex/step-id": "step-a",
        };
        expect(job.metadata?.labels).toEqual(expected);
        expect(job.spec?.template.metadata?.labels).toEqual(expected);
        const annotations = job.metadata?.annotations;
        if (annotations === undefined) throw new Error("annotations is absent");
        expect(annotations["cortex/owner-workflow-id"]).toBe("run-1-0");
    });

    test("the host labels merge under the harness labels, thus a harness key wins a clash", async () => {
        const stub = stubApis(READY_POD);
        (
            await opsWith(stub).createSandbox(...splitSpawn(SPAWN), mintSandboxIdentity("run-1"), {
                "cortex/run-id": "other",
                "example.com/tenant": "acme",
            })
        )._unsafeUnwrap();

        const mergedJob = presentAt(stub.createdJobs, 0);
        const jobLabels = mergedJob.metadata?.labels;
        const templateLabels = mergedJob.spec?.template.metadata?.labels;
        if (jobLabels === undefined || templateLabels === undefined) throw new Error("labels is absent");
        for (const labels of [jobLabels, templateLabels]) {
            expect(labels["cortex/run-id"]).toBe("run-1");
            expect(labels["example.com/tenant"]).toBe("acme");
        }
    });

    test("a host value reaches the Job with no change, also a value that the API server can refuse", async () => {
        // The API server is the authority on a label value: the harness changes
        // no host value, because a host reconciler uses it as a lookup key.
        const stub = stubApis(READY_POD);
        (await opsWith(stub).createSandbox(...splitSpawn(SPAWN), mintSandboxIdentity("run-1"), { "example.com/user": "user@example.com" }))._unsafeUnwrap();

        const hostJob = presentAt(stub.createdJobs, 0);
        expect(hostJob.metadata?.labels?.["example.com/user"]).toBe("user@example.com");
        expect(hostJob.spec?.template.metadata?.labels?.["example.com/user"]).toBe("user@example.com");
    });

    test("a literal spawn path stamps its literal run id and step id", async () => {
        const stub = stubApis(READY_POD);
        (
            await opsWith(stub).createSandbox(
                ...splitSpawn({
                    runId: "data-profile",
                    stepId: "profile",
                    analysisId: "an-1",
                    childWorkflowId: "dataprofile:an-1:n",
                    resources: { cpu: 1, memoryGb: 1 },
                }),
                mintSandboxIdentity("data-profile"),
                {},
            )
        )._unsafeUnwrap();

        const labels = presentAt(stub.createdJobs, 0).spec?.template.metadata?.labels;
        if (labels === undefined) throw new Error("labels is absent");
        expect(labels["cortex/run-id"]).toBe("data-profile");
        expect(labels["cortex/step-id"]).toBe("profile");
    });
});

describe("k8s teardown", () => {
    test("404 on delete is idempotent success", async () => {
        const stub = stubApis([]);
        stub.setDeleteError({ code: 404 });
        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
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
        });
        expect(result.isOk()).toBe(true);
    });

    test("non-404 errors propagate", async () => {
        const stub = stubApis([]);
        stub.setDeleteError({ code: 500 });
        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
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
                    containerStatuses: [
                        {
                            state: { terminated: { reason: "OOMKilled", exitCode: 137 } },
                            image: "sandbox-base:latest",
                            imageID: "sha256:test",
                            name: "step",
                            ready: false,
                            restartCount: 0,
                        },
                    ],
                },
                metadata: { name: "p" },
            },
        ]);
        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
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

        (await opsWith(FIXED_FARM, stub).createSandbox(...splitSpawn(META), mintSandboxIdentity("run-1"), {}))._unsafeUnwrap();

        const container = presentAt(stub.createdJobs, 0).spec?.template.spec?.containers[0];
        if (container === undefined) throw new Error("container is absent");
        const farmMounts = container.volumeMounts;
        if (farmMounts === undefined) throw new Error("volumeMounts is absent");
        const mounts = farmMounts.filter((m) => m.name === "libs");
        expect(mounts.map((m) => ({ mountPath: m.mountPath, subPath: m.subPath, readOnly: m.readOnly }))).toEqual([
            { mountPath: "/mnt/libs", subPath: undefined, readOnly: true },
            { mountPath: "/mnt/libs/current", subPath: "farms/catalog", readOnly: true },
        ]);
    });

    test("a cache location mounts read-write at /mnt/libs/cache through the same claim", async () => {
        const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.3" }, metadata: { name: "sbx-c" } }]);
        const source: FarmSource = { kind: "fixed", location: { farmPath: "farms/an-1", cachePath: "caches/an-1" } };

        (await opsWith(source, stub, "image").createSandbox(...splitSpawn(META), mintSandboxIdentity("run-1"), {}))._unsafeUnwrap();

        const podSpec = presentAt(stub.createdJobs, 0).spec?.template.spec;
        if (podSpec === undefined) throw new Error("podSpec is absent");
        const libsVolume = podSpec.volumes?.find((v) => v.name === "libs");
        if (libsVolume === undefined) throw new Error("libsVolume is absent");
        const claim = libsVolume.persistentVolumeClaim;
        if (claim === undefined) throw new Error("persistentVolumeClaim is absent");
        // The claim carries no volume-level readOnly when the cache writes
        // through it — the per-mount flags keep the store and the farm read-only.
        expect(claim.readOnly).toBeUndefined();

        const cacheContainer = presentAt(podSpec.containers, 0);
        const cacheMounts = cacheContainer.volumeMounts;
        if (cacheMounts === undefined) throw new Error("volumeMounts is absent");
        const mounts = cacheMounts.filter((m) => m.name === "libs");
        expect(mounts.map((m) => ({ mountPath: m.mountPath, subPath: m.subPath, readOnly: m.readOnly }))).toEqual([
            { mountPath: "/mnt/libs", subPath: undefined, readOnly: true },
            { mountPath: "/mnt/libs/farm", subPath: "farms/an-1", readOnly: true },
            { mountPath: "/mnt/libs/cache", subPath: "caches/an-1", readOnly: false },
        ]);
    });

    test("a resolver refusal returns farm_unavailable and creates no Job", async () => {
        const stub = stubApis([]);
        const source: FarmSource = { kind: "per-analysis", resolve: () => Promise.resolve({ kind: "unavailable", reason: "no store yet" }) };

        const result = await opsWith(source, stub).createSandbox(...splitSpawn(META), mintSandboxIdentity("run-1"), {});

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
            (await opsWith(source, stub).createSandbox(...splitSpawn(META), mintSandboxIdentity("run-1"), {}))._unsafeUnwrap();
        };
        await expect(attempt()).rejects.toThrow("PVC-relative");
        expect(stub.createdJobs).toHaveLength(0);
    });
});

describe("k8s waitForPodReady — the slow pod", () => {
    /** A pod list that answers with `pod` every time, and a clock the sleep advances. */
    function pendingPod(pod: V1Pod) {
        let clock = 0;
        const coreApi: CorePodApi = {
            listNamespacedPod: () => Promise.resolve({ items: [pod] }),
        };
        return {
            coreApi,
            now: () => clock,
            sleep: (ms: number) => {
                clock += ms;

                return Promise.resolve();
            },
        };
    }

    test("warns once past a minute, naming the condition the pod waits on", async () => {
        const clockedApi = pendingPod({
            status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", lastTransitionTime: new Date() }] },
            metadata: { name: "sbx-slow" },
        });
        const logger = createCapturingLogger();

        const result = await waitForPodReady(clockedApi.coreApi, "sandbox", "sbx-slow", {
            logger,
            now: clockedApi.now,
            sleep: clockedApi.sleep,
        });

        expect(result.isErr()).toBe(true);
        const warnings = logger.records.filter((r) => r.level === "warn");
        expect(warnings).toHaveLength(1);
        expect(presentAt(warnings, 0).msg).toBe("[k8s-client] sandbox pod is slow to reach Running");
        expect(presentAt(warnings, 0).fields).toMatchObject({ sandboxId: "sbx-slow", phase: "Pending", conditionReason: "Unschedulable" });
        const waitedMs = presentAt(warnings, 0).fields.waitedMs;
        if (typeof waitedMs !== "number") throw new Error("the log carries a numeric waitedMs");
        expect(waitedMs).toBeGreaterThanOrEqual(60_000);
    });

    test("says nothing about a pod that comes up inside the minute", async () => {
        const clockedApi = pendingPod({ status: { phase: "Running", podIP: "10.0.0.9" }, metadata: { name: "sbx-fast" } });
        const logger = createCapturingLogger();

        const result = await waitForPodReady(clockedApi.coreApi, "sandbox", "sbx-fast", {
            logger,
            now: clockedApi.now,
            sleep: clockedApi.sleep,
        });

        expect(result._unsafeUnwrap()).toEqual({ podIP: "10.0.0.9", podName: "sbx-fast" });
        expect(logger.records).toEqual([]);
    });
});
