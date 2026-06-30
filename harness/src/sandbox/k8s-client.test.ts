/**
 * K8s `createSandbox` / `teardown` / `isAlive` shape tests against
 * stubbed BatchV1Api / CoreV1Api. Verifies the Job spec carries the
 * required env vars, teardown is idempotent on 404, and isAlive maps
 * pod phase correctly.
 */

import { describe, expect, test } from "bun:test";
import type { BatchV1Api, CoreV1Api, V1Job, V1Pod } from "@kubernetes/client-node";

import { createK8sSandboxOps, sanitizeLabelValue } from "./k8s-client.js";
import { mintSandboxIdentity } from "./identity.js";

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
        },
        deleteNamespacedJob: async ({ name }: { namespace: string; name: string }) => {
            if (deletedError) throw deletedError;
            existingDeleted = true;
            deletedJobs.push(name);
        },
        // Used by the spawn step's owner-guard (returns the pre-existing Job with
        // its owner label) and then by `waitForJobGone` after a delete (404).
        readNamespacedJob: async ({ name }: { namespace: string; name: string }) => {
            if (existingDeleted) {
                const err = new Error("not found") as Error & { code: number };
                err.code = 404;
                throw err;
            }
            return {
                metadata: {
                    name,
                    labels: { "cortex/owner-workflow-id": existingOwner },
                },
            };
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
    test("creates a Job carrying CORTEX_BASE_URL and SANDBOX_CALLBACK_SECRET env", async () => {
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
            namespace: "sandbox",
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
        expect(envMap.CORTEX_BASE_URL).toBe("https://cortex.example.com:443");
        expect(envMap.SANDBOX_CALLBACK_SECRET).toBe(ref.callbackSecret);
        expect(envMap.PROVENANCE_WATCH_DIRS).toBe("/an-1");
        expect(envMap.R_LIBS_SITE).toContain("/mnt/libs/current/r/");

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

describe("k8s createSandbox failure cleanup", () => {
    test("deletes the Job when the pod fails to come up", async () => {
        // Pod phase Failed → waitForPodReady throws immediately.
        const stub = stubApis([{ status: { phase: "Failed" }, metadata: { name: "p" } }]);
        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
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
        expect(result._unsafeUnwrapErr().type).toBe("container_create_failed");
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
        expect(result._unsafeUnwrapErr().type).toBe("name_conflict");
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

        const labels = stub.createdJobs[0]!.metadata!.labels!;
        expect(labels["app.kubernetes.io/managed-by"]).toBe("cortex");
        expect(labels["cortex/owner-workflow-id"]).toBe("run-1-0");
        expect(labels["cortex/run-id"]).toBe("run-1");
        expect(labels["cortex/step-id"]).toBe("step-a");
    });

    test("sanitizes a colon-bearing workflow id into a valid label value", async () => {
        const stub = stubApis([{ status: { phase: "Running", podIP: "10.0.0.1" }, metadata: { name: "p" } }]);
        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
            sessionPvc: "cortex-sessions",
            batchApi: stub.batchApi,
            coreApi: stub.coreApi,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                {
                    runId: "data-profile",
                    stepId: "profile",
                    analysisId: "an-1",
                    childWorkflowId: "data-profile:data-profiler-g3u48je4",
                    resources: { cpu: 2, memoryGb: 4 },
                },
                mintSandboxIdentity("data-profile"),
            )
        )._unsafeUnwrap();

        const owner = stub.createdJobs[0]!.metadata!.labels!["cortex/owner-workflow-id"]!;
        expect(owner).toBe("data-profile-data-profiler-g3u48je4");
        expect(owner).toMatch(/^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/);
        expect(owner.length).toBeLessThanOrEqual(63);
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
});

describe("k8s teardown", () => {
    test("404 on delete is idempotent success", async () => {
        const stub = stubApis([]);
        stub.setDeleteError({ code: 404 });
        const ops = createK8sSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            namespace: "sandbox",
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
        expect(result._unsafeUnwrapErr().type).toBe("teardown_failed");
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
                batchApi: stub.batchApi,
                coreApi: stub.coreApi,
                registerSandbox: async () => {},
            });
            const alive = (
                await ops.isAlive({
                    sandboxId: "sbx-x",
                    host: "h",
                    port: 1,
                    backend: "k8s",
                    callbackSecret: "x",
                })
            )._unsafeUnwrap();
            expect(alive).toBe(expected);
        }
    });
});
