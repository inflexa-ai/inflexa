/**
 * Ephemeral runner — read-only sandbox execution for ad-hoc data
 * exploration, run as a turn-scoped DBOS workflow.
 *
 * The `run_ephemeral` conversation tool authorizes the run at the async
 * edge, starts this workflow, and awaits its result inline within the chat
 * turn. The workflow is "bare": it has no run-event stream, so `emit` is a
 * no-op and live sandbox progress events are dropped. It is never recovered
 * — chat disconnect cancels it (`DBOS.cancelWorkflow`), and a boot-time sweep
 * cancels any `ephemeral:`-prefixed PENDING workflow a dead pod left behind.
 *
 * Lifecycle: create sandbox → build the ephemeral-executor with synthetic
 * step coords (`runId = stepId = "ephemeral"`, the literal the host-managed
 * billing rules key on) → drive `runAgent` over the executor with `durableStep` →
 * final text + step count → teardown the sandbox in `finally` on every
 * terminal path.
 *
 * Read-only is enforced, not aspirational: the executor agent is built with
 * `readOnly: true` (no `write_file`/`edit_file` tools) and its sandbox is
 * provisioned with no read-write mount — only the read-only analysis tree.
 * Container-local `/tmp` stays writable (torn down with the sandbox); nothing
 * persists. The prompt's "you physically cannot write files" is now true.
 */

import { DBOS, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import type { Pool } from "pg";

import type { RunSession } from "../auth/types.js";
import { forSubAgent } from "../auth/types.js";
import { finalText, runAgent } from "../loop/run-agent.js";
import { durableStep } from "../loop/run-step.js";
import type { ResourceSpec } from "../config/resource-limits.js";
import type { ChatProvider, EmbeddingProvider } from "../providers/types.js";
import type { SandboxClient } from "../sandbox/client.js";
import { generateExecutionId } from "../sandbox/execution-id.js";
import { mintSandboxIdentity } from "../sandbox/identity.js";
import { createEphemeralExecutorAgent } from "../agents/sandbox/ephemeral-executor.js";
import type { SandboxAgentDeps } from "../agents/sandbox/shared.js";
import type { BioToolKeys } from "../tools/bio/keys.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";

/** Sub-agent identity — appended to `callPath`, set as `agentId`. */
export const EPHEMERAL_AGENT_ID = "ephemeral-executor";

/**
 * Synthetic run/step literal stamped into the agent's step coords.
 * Host-managed billing rules key on this literal to recognize chat-turn
 * ephemeral runs (no `cortex_runs` row, no DBOS stream).
 */
const EPHEMERAL_RUN_LITERAL = "ephemeral" as const;

/** Workflow-id prefix — the boot-time never-recover sweep matches on it. */
export const EPHEMERAL_WORKFLOW_PREFIX = "ephemeral:" as const;

/** Default budget — chat-turn-scoped, no recovery, no checkpointing. */
const DEFAULT_DEADLINE_MS = 120_000;

/** Ephemeral runs have no planner estimate, so the sandbox box is chosen here
 *  explicitly — a mid-range request clamped to cluster limits at create time. */
const EPHEMERAL_SANDBOX_RESOURCES: ResourceSpec = { cpu: 4, memoryGb: 8 };

/** The body's construction-time deps — closed over at registration. */
export interface EphemeralDeps {
    readonly provider: ChatProvider;
    readonly pool: Pool;
    readonly sandboxClient: SandboxClient;
    readonly workspaceFs: WorkspaceFilesystem;
    /** Embedding provider for the executor's in-sandbox `workspace_search`. */
    readonly embedding: EmbeddingProvider;
    readonly sessionsBasePath: string;
    /** Model id — provenance / metric label; the provider owns the wire model. */
    readonly model: string;
    /** API keys for the bio/chem tools the ephemeral executor may use. */
    readonly bioKeys: BioToolKeys;
}

/**
 * Workflow input. JSON-serialisable — the authorized `RunSession` carries the
 * run credential; the body reads it and never re-authorizes.
 */
export interface EphemeralWorkflowInput {
    readonly runSession: RunSession;
    readonly prompt: string;
    /** Optional cap on the inner agent's tool-call budget. */
    readonly maxIterations?: number;
    /** Optional deadline override for sandbox-server execs (unix ms). */
    readonly deadlineMs?: number;
}

export interface EphemeralResult {
    readonly text: string;
    readonly durationMs: number;
    readonly stepsUsed: number;
}

/**
 * Register the ephemeral workflow with DBOS. Returns the registered callable
 * so the `run_ephemeral` tool can dispatch via `DBOS.startWorkflow`.
 */
export function registerEphemeralWorkflow(deps: EphemeralDeps): (input: EphemeralWorkflowInput) => Promise<EphemeralResult> {
    return DBOS.registerWorkflow((input: EphemeralWorkflowInput) => runEphemeralBody(input, deps), { name: "ephemeral" });
}

/**
 * Run the ephemeral-executor agent against a fresh read-only sandbox.
 * Throws on sandbox start failure; otherwise returns the agent's final
 * text plus timing. Sandbox teardown fires on every terminal path —
 * success, error, cancel.
 */
export async function runEphemeralBody(input: EphemeralWorkflowInput, deps: EphemeralDeps): Promise<EphemeralResult> {
    const { runSession } = input;
    if (runSession.scope.kind !== "analysis") {
        throw new Error(`runEphemeralBody requires an analysis-scoped session — got ${runSession.scope.kind}`);
    }
    const analysisId = runSession.scope.analysisId;
    const startedAt = performance.now();
    const executionId = generateExecutionId(EPHEMERAL_AGENT_ID);
    const workflowId = DBOS.workflowID ?? `${EPHEMERAL_WORKFLOW_PREFIX}${executionId}`;

    const childSession = forSubAgent(runSession, EPHEMERAL_AGENT_ID);

    console.log(`[ephemeral] execution=${executionId} analysis=${analysisId} starting sandbox`);

    const sandbox = await deps.sandboxClient.createSandbox(
        {
            runId: EPHEMERAL_RUN_LITERAL,
            stepId: EPHEMERAL_RUN_LITERAL,
            analysisId,
            execId: null,
            childWorkflowId: workflowId,
            resources: EPHEMERAL_SANDBOX_RESOURCES,
            // No read-write step mount — only the read-only analysis tree.
            readOnly: true,
        },
        mintSandboxIdentity(EPHEMERAL_RUN_LITERAL),
    );

    try {
        const deadlineAbs = input.deadlineMs ?? Date.now() + DEFAULT_DEADLINE_MS;
        const nextFunctionId = makeNextFunctionId();

        const sandboxAgentDeps: SandboxAgentDeps = {
            provider: deps.provider,
            pool: deps.pool,
            sandboxClient: deps.sandboxClient,
            workspaceFs: deps.workspaceFs,
            embedding: deps.embedding,
            model: deps.model,
            bioKeys: deps.bioKeys,
            step: {
                sandbox,
                sessionsBasePath: deps.sessionsBasePath,
                analysisId,
                runId: EPHEMERAL_RUN_LITERAL,
                stepId: EPHEMERAL_RUN_LITERAL,
                workflowId,
                // Enforced read-only: the executor agent gets no write_file/edit_file
                // tools and the sandbox has no read-write mount. This prefix is not a
                // writable location — it only resolves `execute_command`'s default cwd
                // to the read-only analysis-tree root (`/{analysisId}`), where reads land.
                allowedWritePrefix: `${deps.sessionsBasePath}/${analysisId}`,
                nextFunctionId,
                deadlineMs: () => deadlineAbs,
            },
        };
        const agentDef = createEphemeralExecutorAgent(sandboxAgentDeps);
        const agent = input.maxIterations !== undefined ? { ...agentDef, maxIterations: input.maxIterations } : agentDef;

        const signal = new AbortController().signal;
        const { messages: finalMessages } = await runAgent(agent, [{ role: "user", content: input.prompt }], childSession, {
            provider: deps.provider,
            signal,
            emit: () => {},
            runStep: durableStep,
            isFatalLoopError: (err) => err instanceof DBOSErrors.DBOSWorkflowCancelledError,
        });

        const text = finalText(finalMessages);
        const stepsUsed = countAssistantTurns(finalMessages);
        const durationMs = Math.round(performance.now() - startedAt);
        console.log(`[ephemeral] execution=${executionId} completed stepsUsed=${stepsUsed} durationMs=${durationMs}`);
        return { text, stepsUsed, durationMs };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ephemeral] execution=${executionId} failed: ${message}`);
        throw err;
    } finally {
        try {
            await deps.sandboxClient.teardown(sandbox);
        } catch (teardownErr) {
            // Teardown is idempotent — "already gone" is success. A failure here
            // is best-effort logged so the chat turn doesn't fail on cleanup.
            console.warn(
                `[ephemeral] execution=${executionId} teardown failed (non-fatal): ${teardownErr instanceof Error ? teardownErr.message : teardownErr}`,
            );
        }
    }
}

/** Per-call function-id minter — replay-deterministic. */
function makeNextFunctionId(): () => string {
    let n = 0;
    return () => `fn-${(n++).toString(36)}`;
}

/** The agent's final assistant turn is the `stepsUsed` proxy — every loop
 *  iteration produces one assistant message. */
function countAssistantTurns(messages: readonly { role: string }[]): number {
    let n = 0;
    for (const m of messages) if (m.role === "assistant") n++;
    return n;
}
