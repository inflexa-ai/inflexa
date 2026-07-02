import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUIDv7 } from "bun";
import { ok, err } from "neverthrow";

import { env } from "../../lib/env.ts";
import { bootHarnessRuntime, __resetHarnessRuntimeForTest, type BootSeams } from "./runtime.ts";
import type { ResolvedHarnessConfig } from "./config.ts";
import type { ExecIngress } from "./ingress.ts";

let skillsDir: string;

function testConfig(overrides: Partial<ResolvedHarnessConfig> = {}): ResolvedHarnessConfig {
    skillsDir = join(tmpdir(), `harness-runtime-test-${randomUUIDv7()}`);
    mkdirSync(skillsDir, { recursive: true });
    return {
        model: "claude-test-model",
        embedding: { baseURL: "http://embeddings.test/v1", token: "tok", model: "text-embedding-3-small" },
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        sandboxImage: "sandbox-base:latest",
        resourceLimits: { maxCpu: 1, maxMemoryGb: 1, maxGpuCount: 0 },
        adminPort: 8433,
        skillsDir,
        ...overrides,
    };
}

function fakeIngress(calls: string[]): ExecIngress {
    return {
        port: 65_000,
        cortexBaseUrl: "http://host.docker.internal:65000",
        stop: () => {
            calls.push("ingress.stop");
        },
    };
}

// Seams that record their call order and succeed. The pool/providers built
// between them are pure construction (pg pools connect lazily), so the boot
// path runs fully offline.
function recordingSeams(calls: string[]): BootSeams {
    return {
        ensurePostgres: async () => {
            calls.push("postgres");
            return ok({ host: "localhost", port: 5, database: "d", user: "u", password: "p" });
        },
        startIngress: () => {
            calls.push("ingress");
            return ok(fakeIngress(calls));
        },
        readKey: async () => {
            calls.push("readKey");
            return ok("proxy-key");
        },
        resolveModel: async () => {
            calls.push("resolveModel");
            return ok("claude-from-proxy");
        },
        register: (deps) => {
            calls.push("register");
            // The one base every consumer must share (design D2).
            expect(deps.sessionsBasePath).toBe(env.sessionsDir);
            expect(deps.skillsDir).toBe(skillsDir);
            expect(deps.embedding.baseURL).toBe("http://embeddings.test/v1");
            return async () => {};
        },
        initState: async () => {
            calls.push("initState");
        },
        launch: async () => {
            calls.push("launch");
        },
        probeEmbedding: async () => {
            calls.push("probeEmbedding");
            return ok(undefined);
        },
    };
}

afterEach(() => {
    __resetHarnessRuntimeForTest();
    rmSync(skillsDir, { recursive: true, force: true });
});

describe("bootHarnessRuntime", () => {
    test("boots in the contract order: postgres → ingress → schema init → register → launch", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig() });

        const runtime = result._unsafeUnwrap();
        expect(calls).toEqual(["readKey", "probeEmbedding", "postgres", "ingress", "initState", "register", "launch"]);
        expect(runtime.model).toBe("claude-test-model");
        expect(runtime.triggerDeps.workflow).toBeInstanceOf(Function);
    });

    test("resolves the model from the proxy only when config has none", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig({ model: null }) });

        expect(result._unsafeUnwrap().model).toBe("claude-from-proxy");
        expect(calls).toContain("resolveModel");
    });

    test("second boot reuses the runtime without re-running any seam", async () => {
        const calls: string[] = [];
        const seams = recordingSeams(calls);
        const first = (await bootHarnessRuntime({ seams, config: testConfig() }))._unsafeUnwrap();
        const countAfterFirst = calls.length;

        const second = (await bootHarnessRuntime({ seams, config: testConfig() }))._unsafeUnwrap();
        expect(second).toBe(first);
        expect(calls).toHaveLength(countAfterFirst);
    });

    test("unavailable Postgres short-circuits before ingress/register/launch", async () => {
        const calls: string[] = [];
        const seams: BootSeams = {
            ...recordingSeams(calls),
            ensurePostgres: async () => {
                calls.push("postgres");
                return err({ type: "ready_timeout", message: "pg_isready timed out" });
            },
        };
        const result = await bootHarnessRuntime({ seams, config: testConfig() });

        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "postgres_unavailable" });
        expect(calls).toEqual(["readKey", "probeEmbedding", "postgres"]);
    });

    test("missing embedding config fails before any side effect", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig({ embedding: null }) });

        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "embedding_unconfigured" });
        expect(calls).toEqual([]);
    });

    test("an unreachable embedding endpoint blocks before postgres/ingress/launch", async () => {
        const calls: string[] = [];
        const seams: BootSeams = {
            ...recordingSeams(calls),
            probeEmbedding: async () => {
                calls.push("probeEmbedding");
                return err({ baseURL: "http://embeddings.test/v1", detail: "HTTP 404" });
            },
        };
        const result = await bootHarnessRuntime({ seams, config: testConfig() });

        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "embedding_unreachable", detail: "HTTP 404" });
        expect(calls).toEqual(["readKey", "probeEmbedding"]);
    });

    test("missing skills dir fails before any side effect", async () => {
        const calls: string[] = [];
        const cfg = testConfig();
        rmSync(skillsDir, { recursive: true, force: true });
        const result = await bootHarnessRuntime({ seams: recordingSeams(calls), config: cfg });

        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "skills_dir_missing" });
        expect(calls).toEqual([]);
    });

    test("a throwing launch releases the ingress and reports runtime_boot_failed", async () => {
        const calls: string[] = [];
        const seams: BootSeams = {
            ...recordingSeams(calls),
            launch: async () => {
                calls.push("launch");
                throw new Error("dbos exploded");
            },
        };
        const result = await bootHarnessRuntime({ seams, config: testConfig() });

        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "runtime_boot_failed" });
        expect(calls).toContain("ingress.stop");
    });
});
