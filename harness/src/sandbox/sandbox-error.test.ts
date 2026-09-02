import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { describeSandboxError, SandboxFailure, sandboxStatusOf, trySandbox, type SandboxError } from "./sandbox-error.js";

/** An unusable farm, as the two lock gates raise it. */
function farmUnusable(over: Partial<Extract<SandboxError, { type: "farm_unusable" }>> = {}): SandboxError {
    return {
        type: "farm_unusable",
        op: "docker.createSandbox",
        analysisId: "an-1",
        farmPath: "/mnt/libs/farms/catalog",
        lockPath: "/mnt/libs/farms/catalog/inflexa.lock",
        lockError: "lock_invalid",
        cause: undefined,
        ...over,
    };
}

/** A dockerode-style throw: status on `.statusCode`. */
function dockerodeThrow(statusCode: number): Error & { statusCode: number } {
    return Object.assign(new Error(`docker ${statusCode}`), { statusCode });
}

/** A @kubernetes/client-node v1.x throw: numeric status on `.code`. */
function k8sThrow(code: number): Error & { code: number } {
    return Object.assign(new Error(`k8s ${code}`), { code });
}

describe("sandbox-error", () => {
    describe("sandboxStatusOf", () => {
        it("reads dockerode .statusCode", () => {
            expect(sandboxStatusOf(dockerodeThrow(404))).toBe(404);
            expect(sandboxStatusOf(dockerodeThrow(409))).toBe(409);
        });

        it("reads k8s numeric .code", () => {
            expect(sandboxStatusOf(k8sThrow(404))).toBe(404);
        });

        it("reads a nested .response.statusCode", () => {
            expect(sandboxStatusOf({ response: { statusCode: 500 } })).toBe(500);
        });

        it("ignores a string system-error code (ECONNREFUSED) — not a status", () => {
            const sysErr = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
            expect(sandboxStatusOf(sysErr)).toBeUndefined();
        });

        it("is undefined when no status signal is present", () => {
            expect(sandboxStatusOf(new Error("plain"))).toBeUndefined();
        });
    });

    describe("trySandbox", () => {
        it("returns ok with the mapped value on a successful op", async () => {
            const result = await trySandbox(
                async () => true,
                (status, cause) => ({
                    type: "liveness_failed",
                    op: "docker.isAlive",
                    status,
                    cause,
                }),
            );
            expect(result.isOk()).toBe(true);
            expect(result._unsafeUnwrap()).toBe(true);
        });

        it("a throw is classified by the caller's toError, receiving the parsed status + cause", async () => {
            const cause = dockerodeThrow(500);
            const result = await trySandbox(
                async () => {
                    throw cause;
                },
                (status, c) => ({
                    type: "container_create_failed",
                    op: "docker.createSandbox",
                    sandboxId: "sbx-1",
                    status,
                    cause: c,
                }),
            );
            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
                const e = result.error;
                expect(e.type).toBe("container_create_failed");
                expect(e.op).toBe("docker.createSandbox");
                if (e.type === "container_create_failed") {
                    expect(e.sandboxId).toBe("sbx-1");
                    expect(e.status).toBe(500);
                    expect(e.cause).toBe(cause);
                }
            }
        });

        it("the caller can special-case a 409 into a name_conflict err", async () => {
            const result = await trySandbox(
                async () => {
                    throw dockerodeThrow(409);
                },
                (status, cause) =>
                    status === 409
                        ? { type: "name_conflict", op: "docker.createSandbox", sandboxId: "sbx-2", owner: "other", cause }
                        : { type: "container_create_failed", op: "docker.createSandbox", status, cause },
            );
            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
                const e = result.error;
                expect(e.type).toBe("name_conflict");
                if (e.type === "name_conflict") {
                    expect(e.owner).toBe("other");
                    expect(e.sandboxId).toBe("sbx-2");
                }
            }
        });

        it("a k8s numeric .code is parsed and handed to toError as the status", async () => {
            const result = await trySandbox(
                async () => {
                    throw k8sThrow(404);
                },
                (status, cause) => ({ type: "teardown_failed", op: "k8s.teardown", status, cause }),
            );
            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
                const e = result.error;
                expect(e.type).toBe("teardown_failed");
                if (e.type === "teardown_failed") expect(e.status).toBe(404);
            }
        });
    });

    describe("describeSandboxError", () => {
        it("renders each variant to a one-line description", () => {
            const cases: Array<[SandboxError, string]> = [
                [{ type: "container_create_failed", op: "docker.create", sandboxId: "s1", cause: 1 }, "sandbox create failed (docker.create: s1)"],
                [{ type: "container_create_failed", op: "docker.create", cause: 1 }, "sandbox create failed (docker.create)"],
                [
                    { type: "name_conflict", op: "docker.create", sandboxId: "s1", owner: "alice", cause: 1 },
                    "sandbox name collision (docker.create: s1 owned by alice)",
                ],
                [
                    { type: "name_conflict", op: "docker.create", sandboxId: "s1", owner: null },
                    "sandbox name collision (docker.create: s1 owned by <unlabeled>)",
                ],
                [{ type: "not_found", op: "docker.inspect", sandboxId: "s1" }, "sandbox not found (docker.inspect: s1)"],
                [{ type: "not_found", op: "docker.inspect" }, "sandbox not found (docker.inspect)"],
                [{ type: "submit_failed", op: "submitExec", execId: "wf:step:1", cause: 1 }, "sandbox exec submit failed (submitExec: execId=wf:step:1)"],
                [{ type: "teardown_failed", op: "k8s.teardown", sandboxId: "s1", cause: 1 }, "sandbox teardown failed (k8s.teardown: s1)"],
                [{ type: "liveness_failed", op: "docker.isAlive", cause: 1 }, "sandbox liveness probe failed (docker.isAlive)"],
            ];
            for (const [e, expected] of cases) {
                expect(describeSandboxError(e)).toBe(expected);
            }
        });

        it("an unusable farm names the lock path and the lock error", () => {
            expect(describeSandboxError(farmUnusable({ lockError: "lock_unreadable" }))).toBe(
                "farm unusable (docker.createSandbox: an-1) — no usable inflexa.lock at /mnt/libs/farms/catalog/inflexa.lock (lock_unreadable)",
            );
        });

        it("ends with the first line of an Error cause, so the engine names its reason", () => {
            const cause = new Error("no such image: sandbox-base:latest\n    at ImageStore.pull (docker.js:1)");
            expect(describeSandboxError({ type: "container_create_failed", op: "docker.create", sandboxId: "s1", cause })).toBe(
                "sandbox create failed (docker.create: s1) — no such image: sandbox-base:latest",
            );
        });

        it("bounds a long cause line at 200 characters and marks the cut", () => {
            const head = "sandbox create failed (docker.create)";
            const description = describeSandboxError({ type: "container_create_failed", op: "docker.create", cause: new Error("x".repeat(500)) });

            expect(description.startsWith(`${head} — `)).toBe(true);
            const line = description.slice(head.length + 3);
            expect(line).toHaveLength(200);
            expect(line.endsWith("…")).toBe(true);
        });

        it("a cause with no message adds nothing", () => {
            expect(describeSandboxError({ type: "teardown_failed", op: "k8s.teardown", cause: new Error("") })).toBe("sandbox teardown failed (k8s.teardown)");
            expect(describeSandboxError({ type: "liveness_failed", op: "docker.isAlive", cause: undefined })).toBe(
                "sandbox liveness probe failed (docker.isAlive)",
            );
        });

        it("a zod cause renders as its first issue, never as the JSON of its message", () => {
            // The lock gate hands a `ZodError` through, and its `message` is
            // multi-line JSON whose first line is `[` — which names nothing.
            const parsed = z.object({ schema: z.literal(1) }).safeParse({ schema: 99 });
            if (parsed.success) throw new Error("the fixture must fail to parse");
            const issue = parsed.error.issues[0]!;

            const description = describeSandboxError(farmUnusable({ cause: parsed.error }));

            expect(description.endsWith(` — schema: ${issue.message}`)).toBe(true);
            expect(description).not.toContain("[");
        });

        it("a zod issue with no path renders its message alone", () => {
            const parsed = z.number().safeParse("not a number");
            if (parsed.success) throw new Error("the fixture must fail to parse");
            const issue = parsed.error.issues[0]!;

            expect(describeSandboxError(farmUnusable({ cause: parsed.error })).endsWith(` — ${issue.message}`)).toBe(true);
        });

        it("a string cause renders as its first line", () => {
            expect(describeSandboxError({ type: "liveness_failed", op: "docker.isAlive", cause: "engine socket closed\nsecond line" })).toBe(
                "sandbox liveness probe failed (docker.isAlive) — engine socket closed",
            );
        });

        it("an unavailable farm keeps the resolver reason as its one dash, with no cause line after it", () => {
            expect(
                describeSandboxError({
                    type: "farm_unavailable",
                    op: "docker.createSandbox",
                    analysisId: "an-1",
                    reason: "the farm resolver threw",
                    cause: new Error("boom"),
                }),
            ).toBe("farm unavailable (docker.createSandbox: an-1) — the farm resolver threw");
        });
    });

    describe("SandboxFailure", () => {
        it("carries the description as its message and the variant on both cause and error", () => {
            const e = farmUnusable();

            const failure = new SandboxFailure(e);

            expect(failure).toBeInstanceOf(Error);
            expect(failure.message).toBe(describeSandboxError(e));
            expect(failure.cause).toBe(e);
            expect(failure.error).toBe(e);
            expect(failure.name).toBe("SandboxFailure");
        });
    });
});
