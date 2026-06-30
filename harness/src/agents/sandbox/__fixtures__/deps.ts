/**
 * Test-only `SandboxAgentDeps` builder. Hands every dependency a stub so
 * `createSandboxAgent` builds without touching Postgres, the network, or
 * a real sandbox.
 */

import { okAsync } from "neverthrow";
import type { Pool } from "pg";

import type { ChatProvider } from "../../../providers/types.js";
import type { SandboxClient } from "../../../sandbox/client.js";
import type { CreateSandboxMeta, ExecEmit, ExecResult, SandboxRef, SubmitExecBody } from "../../../sandbox/types.js";
import type { WorkspaceFilesystem } from "../../../workspace/filesystem.js";

import type { SandboxAgentDeps } from "../shared.js";

export function makeFakeSandboxClient(): SandboxClient {
    const ref: SandboxRef = {
        sandboxId: "sb-test",
        host: "127.0.0.1",
        port: 8765,
        backend: "docker",
        callbackSecret: "secret",
    };
    return {
        async createSandbox(_meta: CreateSandboxMeta) {
            return ref;
        },
        async submitExec(_ref: SandboxRef, _body: SubmitExecBody) {},
        async awaitExec(execId: string, _secret: string, _emit: ExecEmit, _deadline: number): Promise<ExecResult> {
            return {
                execId,
                exitCode: 0,
                stdout: "",
                stderr: "",
                durationMs: 1,
                timedOut: false,
            };
        },
        async isAlive() {
            return true;
        },
        async teardown() {},
        async teardownById() {},
        async listManagedSandboxes() {
            return [];
        },
    };
}

export function makeFakeWorkspaceFs(): WorkspaceFilesystem {
    return {
        readFile() {
            return okAsync({ kind: "ok", content: Buffer.alloc(0), truncated: false });
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
        chat() {
            throw new Error("fake chat provider — not exercised in these tests");
        },
        async *chatStream() {
            throw new Error("fake chat provider — not exercised in these tests");
        },
    };
}

export function makeFakePool(): Pool {
    return {} as Pool;
}

export interface MakeDepsOverrides {
    readonly model?: string;
    readonly analysisId?: string;
    readonly runId?: string;
    readonly stepId?: string;
    readonly workflowId?: string;
    readonly allowedWritePrefix?: string;
}

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
                callbackSecret: "secret",
            },
            sessionsBasePath: "/tmp/sessions",
            analysisId: over.analysisId ?? "analysis-001",
            runId: over.runId ?? "run-001",
            stepId: over.stepId ?? "step-001",
            workflowId: over.workflowId ?? "wf-001",
            allowedWritePrefix: over.allowedWritePrefix ?? "/tmp/sessions/analysis-001/runs/run-001/step-001",
            nextFunctionId: (() => {
                let n = 0;
                return () => `fn-${++n}`;
            })(),
            deadlineMs: () => Date.now() + 60_000,
        },
    };
}
