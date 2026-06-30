/**
 * Live-DBOS integration tests for the target-assessment workflow internals.
 *
 * Covers tasks.md:
 *  - §8.5 / §14.3 — `runLlmStep` classifies billing gateway 402 (`isBudgetExceeded`)
 *    vs every other throw. On 402 it sends a marker on the
 *    `BUDGET_EXCEEDED_TOPIC` and returns a sentinel; the cancel materialises
 *    later in the terminal block (not from inside the wrapper). On any other
 *    throw the original error rethrows so the caller wraps it as a
 *    `coverage: "queried_no_data"` envelope.
 *  - §14.5 — `emitProgress` writes a typed `data-target-assessment-progress`
 *    part to `DBOS.writeStream("progress", ...)` AND updates
 *    `cortex_target_assessments.progress` via a single `DBOS.runStep`.
 *
 * Why one file: DBOS `registerWorkflow` is process-global and rejected once
 * the engine launches. The rig's launch is lazy inside `setupDbosForTests`,
 * so module-top registrations across multiple test files would race the
 * first file's launch and surface as `DBOSConflictingRegistrationError`.
 * `just test-workflow` runs each DBOS test file in its own `bun test`
 * invocation to dodge that — co-locating both suites in one file keeps the
 * file count down without changing that contract.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { ResultAsync, err, ok } from "neverthrow";

import { toProviderError } from "../../../providers/errors.js";
import { setupDbosForTests, type DbosTestRig } from "../../../__tests__/setup/dbos.js";
import { unwrapOrThrow } from "../../../lib/result.js";
import { insertAssessment, getAssessment } from "../../../state/target-assessments.js";
import { BUDGET_EXCEEDED_SENTINEL, BUDGET_EXCEEDED_TOPIC, runLlmStep, type BudgetExceededMarker } from "../../target-assessment/lib/llm-step.js";
import { emitProgress } from "../../target-assessment/progress.js";
import type { AgentChat, ChatRequest } from "../../../providers/types.js";
import { makeLocalAuth } from "../../../auth/local-auth-context.js";
import type { AgentSession, RunSession } from "../../../auth/types.js";

// ── Fake provider + session helpers ────────────────────────────────────

interface ProviderCall {
    readonly req: ChatRequest;
    readonly session: AgentSession;
    readonly signal?: AbortSignal;
}

function makeProvider(behavior: () => Promise<Message>): {
    provider: AgentChat;
    calls: ProviderCall[];
} {
    const calls: ProviderCall[] = [];
    const provider: AgentChat = {
        chat(req, session, signal) {
            calls.push({ req, session, signal });
            // Mirror the real provider: a thrown SDK failure becomes
            // `err(ProviderError)` carrying the original throwable on `.cause`, so
            // `runLlmStep`'s `unwrapOrThrow` rethrows a `ResultError` whose cause
            // chain still reaches the status-402 signal `isBudgetExceeded` walks.
            return new ResultAsync(
                behavior().then(
                    (message) => ok(message),
                    (e) => err(toProviderError(e, "test")),
                ),
            );
        },
    };
    return { provider, calls };
}

function fakeSession(): RunSession {
    return {
        identity: { user: "user_test" },
        scope: {
            kind: "target-assessment",
            targetAssessmentId: "ta_test",
            billingContextId: "bc_test",
        },
        provenance: { agentId: "test-agent", callPath: ["test-agent"] },
        runFrame: { runId: "ta_test" },
        auth: makeLocalAuth(),
    };
}

function fakeChatRequest(): ChatRequest {
    return {
        messages: [{ role: "user", content: "ping" }],
    };
}

function fakeMessage(text: string): Message {
    return {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text, citations: null }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
            service_tier: null,
        },
    } as unknown as Message;
}

class FakeBillingError extends Error {
    readonly statusCode: number;
    constructor(statusCode: number, message: string) {
        super(message);
        this.name = "FakeBillingError";
        this.statusCode = statusCode;
    }
}

// ── Module-top workflow registrations (must precede DBOS.launch) ───────
//
// `runLlmStep` and `emitProgress` are only callable from inside a DBOS
// workflow body — they use `DBOS.runStep` / `DBOS.writeStream` and read
// `DBOS.workflowID`. The harnesses below are tiny workflows that drive one
// invocation each and surface the result back to the test caller.

interface LlmStepHarnessInput {
    readonly mode: "ok" | "402-status" | "402-message" | "503";
}
interface LlmStepHarnessOutput {
    readonly kind: "ok" | "budget-exceeded" | "threw";
    readonly errorMessage?: string;
    readonly providerCallCount: number;
    readonly marker: BudgetExceededMarker | null;
}

let currentProvider: AgentChat | undefined;
let currentProviderCallCount = 0;

function installProviderForBehavior(mode: LlmStepHarnessInput["mode"]): void {
    currentProviderCallCount = 0;
    const { provider } = makeProvider(async () => {
        currentProviderCallCount += 1;
        if (mode === "ok") return fakeMessage("hello");
        if (mode === "402-status") {
            throw new FakeBillingError(402, "billing gateway: payment required");
        }
        if (mode === "402-message") {
            throw new Error("upstream said: budget exceeded for VK");
        }
        throw new FakeBillingError(503, "billing gateway: upstream unavailable");
    });
    currentProvider = provider;
}

// The marker drain happens INSIDE the producer workflow so the receiver
// shares the producer's workflowID — `DBOS.recv` only sees messages
// addressed to the current workflow. Starting a separate "drain" workflow
// against the same workflowID would surface `DBOSConflictingWorkflowError`
// (different function name on the same id), so we co-locate.
const llmStepHarness = DBOS.registerWorkflow(
    async (input: LlmStepHarnessInput): Promise<LlmStepHarnessOutput> => {
        if (!currentProvider) {
            throw new Error("test bug: provider not installed before harness run");
        }
        let kind: LlmStepHarnessOutput["kind"];
        let errorMessage: string | undefined;
        try {
            const res = await runLlmStep({
                stepName: `ta-test:${input.mode}:0`,
                agentId: "test-agent",
                provider: currentProvider,
                req: fakeChatRequest(),
                session: fakeSession(),
            });
            kind = res.kind;
        } catch (err) {
            kind = "threw";
            errorMessage = err instanceof Error ? err.message : String(err);
        }
        const marker = (await DBOS.recv<BudgetExceededMarker>(BUDGET_EXCEEDED_TOPIC, 0)) ?? null;
        return {
            kind,
            errorMessage,
            providerCallCount: currentProviderCallCount,
            marker,
        };
    },
    { name: "ta-llm-step-harness" },
);

let currentEmitArgs: { assessmentId: string } | undefined;
const emitProgressHarness = DBOS.registerWorkflow(
    async (input: { phase: Parameters<typeof emitProgress>[2] }): Promise<void> => {
        if (!currentEmitArgs || !currentPool) {
            throw new Error("test bug: emit harness deps not installed");
        }
        await emitProgress(currentPool, currentEmitArgs.assessmentId, input.phase);
    },
    { name: "ta-emit-progress-harness" },
);

let currentPool: import("pg").Pool | undefined;

// ── Suite ──────────────────────────────────────────────────────────────

describe("target-assessment internals (DBOS)", () => {
    let rig: DbosTestRig;

    beforeAll(async () => {
        rig = await setupDbosForTests("ta_internals");
        currentPool = rig.pool;
    });

    afterAll(async () => {
        await rig.drop();
    });

    describe("runLlmStep", () => {
        it("returns the message on a successful provider call", async () => {
            installProviderForBehavior("ok");
            const wfId = rig.nextWorkflowId("ta-ok-");
            const handle = await DBOS.startWorkflow(llmStepHarness, {
                workflowID: wfId,
            })({ mode: "ok" });
            const result = await handle.getResult();
            expect(result.kind).toBe("ok");
            expect(result.providerCallCount).toBe(1);
            expect(result.marker).toBeNull();
        });

        it("classifies a structured 402 → sentinel + marker on topic", async () => {
            installProviderForBehavior("402-status");
            const wfId = rig.nextWorkflowId("ta-402s-");
            const runHandle = await DBOS.startWorkflow(llmStepHarness, {
                workflowID: wfId,
            })({ mode: "402-status" });
            const result = await runHandle.getResult();

            expect(result.kind).toBe("budget-exceeded");
            expect(result.providerCallCount).toBe(1);
            expect(result.marker).not.toBeNull();
            expect(result.marker!.stepName).toBe("ta-test:402-status:0");
            expect(result.marker!.agentId).toBe("test-agent");
            expect(result.marker!.error).toContain("payment required");
        });

        it("classifies a pattern-matched 402 message → sentinel", async () => {
            installProviderForBehavior("402-message");
            const wfId = rig.nextWorkflowId("ta-402m-");
            const handle = await DBOS.startWorkflow(llmStepHarness, {
                workflowID: wfId,
            })({ mode: "402-message" });
            const result = await handle.getResult();
            expect(result.kind).toBe("budget-exceeded");
            expect(result.marker).not.toBeNull();
            expect(result.marker!.error).toMatch(/budget exceeded/i);
        });

        it("rethrows a non-402 error (503) so the caller can wrap as queried_no_data", async () => {
            installProviderForBehavior("503");
            const wfId = rig.nextWorkflowId("ta-503-");
            const handle = await DBOS.startWorkflow(llmStepHarness, {
                workflowID: wfId,
            })({ mode: "503" });
            const result = await handle.getResult();
            expect(result.kind).toBe("threw");
            expect(result.errorMessage).toContain("upstream unavailable");
            // No marker on the non-402 path.
            expect(result.marker).toBeNull();
        });

        it("exports the BUDGET_EXCEEDED_SENTINEL symbol as a stable identity", () => {
            // Defensive — the sentinel is consumed by call-site type narrowing in
            // the workflow body; renaming or reconstructing it would silently
            // break that narrowing in production.
            expect(typeof BUDGET_EXCEEDED_SENTINEL).toBe("symbol");
            expect(BUDGET_EXCEEDED_SENTINEL.description).toBe("ta.budget-exceeded");
        });
    });

    describe("emitProgress", () => {
        it("writes a typed progress part to the DBOS stream and updates the row", async () => {
            const assessmentId = unwrapOrThrow(
                await insertAssessment(rig.pool, {
                    organizationId: "org_test",
                    targetId: "ENSG00000146648",
                    targetLabel: "EGFR",
                    billingContextId: "bc_test",
                    requestedBy: "user_test",
                }),
            );
            currentEmitArgs = { assessmentId };

            const handle = await DBOS.startWorkflow(emitProgressHarness, {
                workflowID: assessmentId,
            })({ phase: "deciding" });
            await handle.getResult();

            const entries: Array<Record<string, unknown>> = [];
            for await (const entry of DBOS.readStream<Record<string, unknown>>(assessmentId, "progress")) {
                entries.push(entry);
            }
            expect(entries.length).toBeGreaterThanOrEqual(1);
            const last = entries[entries.length - 1];
            expect(last["type"]).toBe("data-target-assessment-progress");
            const payload = last["payload"] as Record<string, unknown>;
            expect(payload["phase"]).toBe("deciding");
            expect(payload["percent"]).toBe(55);
            expect(payload["message"]).toMatch(/triaging|modulators/i);
            expect(typeof payload["at"]).toBe("string");

            const row = unwrapOrThrow(await getAssessment(rig.pool, assessmentId, "org_test"));
            expect(row).not.toBeNull();
            expect(row!.status).toBe("running");
            expect(row!.progress).toMatch(/triaging|modulators/i);
        });

        it("flips the row to 'completed' on the terminal completed phase", async () => {
            const assessmentId = unwrapOrThrow(
                await insertAssessment(rig.pool, {
                    organizationId: "org_test",
                    targetId: "ENSG00000142208",
                    targetLabel: "AKT1",
                    billingContextId: "bc_test",
                    requestedBy: "user_test",
                }),
            );
            currentEmitArgs = { assessmentId };

            const handle = await DBOS.startWorkflow(emitProgressHarness, {
                workflowID: assessmentId,
            })({ phase: "completed" });
            await handle.getResult();

            const row = unwrapOrThrow(await getAssessment(rig.pool, assessmentId, "org_test"));
            expect(row!.status).toBe("completed");
            expect(row!.progress).toBe("Completed");
        });

        it("flips the row to 'failed' on the terminal failed phase", async () => {
            const assessmentId = unwrapOrThrow(
                await insertAssessment(rig.pool, {
                    organizationId: "org_test",
                    targetId: "ENSG00000133703",
                    targetLabel: "KRAS",
                    billingContextId: "bc_test",
                    requestedBy: "user_test",
                }),
            );
            currentEmitArgs = { assessmentId };

            const handle = await DBOS.startWorkflow(emitProgressHarness, {
                workflowID: assessmentId,
            })({ phase: "failed" });
            await handle.getResult();

            const row = unwrapOrThrow(await getAssessment(rig.pool, assessmentId, "org_test"));
            expect(row!.status).toBe("failed");
        });
    });
});
