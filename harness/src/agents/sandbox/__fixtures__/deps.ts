/**
 * Test-only `SandboxAgentDeps` builder. Hands every dependency a stub so
 * `createSandboxAgent` builds without touching Postgres, the network, or
 * a real sandbox.
 */

import { okAsync } from "neverthrow";
import { Pool } from "pg";

import { unusedChatProvider } from "../../../providers/__fixtures__/chat-provider.js";
import type { ChatProvider } from "../../../providers/types.js";
import type { SandboxClient } from "../../../sandbox/client.js";
import { leaseOverClient } from "../../../sandbox/__fixtures__/leases.js";
import type { ExecResult, SandboxRef } from "../../../sandbox/types.js";
import type { WorkspaceFilesystem } from "../../../workspace/filesystem.js";

import type { SandboxAgentDeps } from "../shared.js";

export function makeFakeSandboxClient(): SandboxClient {
    const ref: SandboxRef = {
        sandboxId: "sb-test",
        host: "127.0.0.1",
        port: 8765,
        backend: "docker",
    };
    return {
        toolchainSource: "store",
        resourceLimits: { maxCpu: 4, maxMemoryGb: 16, maxGpuCount: 0 },
        createSandbox() {
            return okAsync(ref);
        },
        exec(): Promise<ExecResult> {
            return Promise.resolve({
                execId: "wf-001:1",
                exitCode: 0,
                stdout: "",
                stderr: "",
                durationMs: 1,
                timedOut: false,
            });
        },
        isAlive() {
            return Promise.resolve({ alive: true, oomKilled: false });
        },
        isAliveById() {
            return Promise.resolve({ alive: true, oomKilled: false });
        },
        async teardown() {},
        async teardownById() {},
        listManagedSandboxes() {
            return Promise.resolve([]);
        },
    };
}

export function makeFakeWorkspaceFs(): WorkspaceFilesystem {
    return {
        readFile() {
            return okAsync({ kind: "ok", content: Buffer.alloc(0), truncated: false });
        },
        readBytes() {
            return okAsync({ kind: "ok", bytes: Buffer.alloc(0) });
        },
        list() {
            return okAsync({ kind: "ok", entries: [] });
        },
        stat() {
            return okAsync({ kind: "not_found" });
        },
    } satisfies WorkspaceFilesystem;
}

export function makeFakeChatProvider(): ChatProvider {
    return unusedChatProvider();
}

/** An unconnected real pool: the fixtures never reach a query (the fake provider fails first). */
export function makeFakePool(): Pool {
    return new Pool();
}

export type MakeDepsOverrides = {
    readonly model?: string;
    readonly analysisId?: string;
    readonly allowedWritePrefix?: string;
};

export function makeFakeSandboxAgentDeps(over: MakeDepsOverrides = {}): SandboxAgentDeps {
    return {
        provider: makeFakeChatProvider(),
        pool: makeFakePool(),
        toolchainSource: "store",
        workspaceFs: makeFakeWorkspaceFs(),
        model: over.model ?? "claude-opus-4-7",
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        step: {
            lease: leaseOverClient(makeFakeSandboxClient(), { sandboxId: "sb-test", host: "127.0.0.1", port: 8765, backend: "docker" }),
            workspaceRoot: "/tmp/sessions/analysis-001",
            analysisId: over.analysisId ?? "analysis-001",
            allowedWritePrefix: over.allowedWritePrefix ?? "/tmp/sessions/analysis-001/runs/run-001/step-001",
        },
    };
}
