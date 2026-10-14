/**
 * Test-only `SandboxAgentDeps` builder. Hands every dependency a stub so
 * `createSandboxAgent` builds without touching Postgres, the network, or
 * a real sandbox.
 */

import { okAsync } from "neverthrow";
import type { Pool } from "pg";

import type { ChatProvider } from "../../../providers/types.js";
import type { SandboxClient } from "../../../sandbox/client.js";
import type { ExecResult, SandboxRef } from "../../../sandbox/types.js";
import type { WorkspaceFilesystem } from "../../../workspace/filesystem.js";

import type { SandboxAgentDeps } from "../shared.js";
import { poolDouble } from "../../../lib/test/doubles.js";

export function makeFakeSandboxClient(): SandboxClient {
    const ref: SandboxRef = {
        sandboxId: "sb-test",
        host: "127.0.0.1",
        port: 8765,
        backend: "docker",
    };
    return {
        toolchainSource: "store",
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
    return {
        capabilities: { toolCalling: true },
        chat() {
            throw new Error("fake chat provider — not exercised in these tests");
        },
        chatStream() {
            throw new Error("fake chat provider — not exercised in these tests");
        },
    };
}

export function makeFakePool(): Pool {
    // SAFETY: a hand-built double of the seam under test — the test drives only the members this object declares, so the missing members are never read.
    return poolDouble();
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
        sandboxClient: makeFakeSandboxClient(),
        workspaceFs: makeFakeWorkspaceFs(),
        model: over.model ?? "claude-opus-4-7",
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        step: {
            sandbox: {
                sandboxId: "sb-test",
                host: "127.0.0.1",
                port: 8765,
                backend: "docker",
            },
            workspaceRoot: "/tmp/sessions/analysis-001",
            analysisId: over.analysisId ?? "analysis-001",
            allowedWritePrefix: over.allowedWritePrefix ?? "/tmp/sessions/analysis-001/runs/run-001/step-001",
            deadlineMs: () => Date.now() + 60_000,
        },
    };
}
