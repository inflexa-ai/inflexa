/**
 * The approval of a workflow. A chat turn and a sandbox step raise an ask in a step, and they wait for the answer
 * with a durable wait of their body, thus a recovery waits again for the same ask. The ask row records the workflow
 * that waits, and the answer of a host goes to that workflow.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import { z } from "zod";

import type { AskPart } from "../../contracts/chat-parts.js";
import type { ApprovalDecision, LoopOptions } from "../../loop/run-loop.js";
import { stepUuid } from "../workspace/edit-file.js";
import type { AskReply } from "./contract.js";
import { askPartOf, type AskGateway, type AskScope } from "./gateway.js";
import type { AnswerOutcome } from "./queries.js";

/** A workflow waits half an hour for the answer of an ask, and then the ask expires. */
export const DEFAULT_ASK_WAIT_SECONDS = 30 * 60;

const AskReplySchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("once") }),
    z.object({ kind: z.literal("always") }),
    z.object({ kind: z.literal("reject"), feedback: z.string().optional() }),
]);

/** The topic of the message that carries the answer of one ask to its workflow. */
function askTopic(askId: string): string {
    return `ask:${askId}`;
}

export type WorkflowApprovalOpts = {
    readonly gateway: AskGateway;
    /** The workflow that waits. The id of each ask comes from it and the id of the call, thus a replay raises the same ask. */
    readonly workflowId: string;
    readonly scope: Omit<AskScope, "workflowId">;
    /** The prefix of the names of the steps, for example `chat-turn`. */
    readonly stepPrefix: string;
    readonly emitPart: (part: AskPart) => Promise<void>;
    /** A stop of the work: the wait ends, the ask is `aborted`, and the approver throws the reason. */
    readonly signal?: AbortSignal;
    readonly waitSeconds: number;
};

/** The approver of a loop that runs in the body of a workflow. */
export function workflowApproval(opts: WorkflowApprovalOpts): NonNullable<LoopOptions["approve"]> {
    const { gateway, emitPart, signal } = opts;
    const scope: AskScope = { ...opts.scope, workflowId: opts.workflowId };
    return async (request, call): Promise<ApprovalDecision> => {
        const id = stepUuid(`${opts.workflowId}:ask:${call.toolCallId}`);
        const raised = await DBOS.runStep(() => gateway.raise(id, request, scope), { name: `${opts.stepPrefix}.ask` });
        if (raised === "granted") {
            await emitPart(askPartOf(id, request, "resolved", "always"));
            return { kind: "approved" };
        }
        await emitPart(askPartOf(id, request, "pending"));

        const received = DBOS.recv<unknown>(askTopic(id), opts.waitSeconds);
        const answered =
            signal === undefined
                ? await received
                : await Promise.race([
                      received,
                      new Promise<"stopped">((resolve) => {
                          if (signal.aborted) resolve("stopped");
                          signal.addEventListener("abort", () => resolve("stopped"), { once: true });
                      }),
                  ]);
        if (answered === "stopped") {
            await DBOS.runStep(() => gateway.abort(id), { name: `${opts.stepPrefix}.ask-abort` });
            await emitPart(askPartOf(id, request, "aborted"));
            throw signal?.reason ?? new DOMException("The work stopped.", "AbortError");
        }
        const reply = AskReplySchema.safeParse(answered);
        if (!reply.success) {
            await DBOS.runStep(() => gateway.expire(id), { name: `${opts.stepPrefix}.ask-expire` });
            await emitPart(askPartOf(id, request, "expired"));
            return { kind: "denied", feedback: "The approval expired unanswered." };
        }
        if (reply.data.kind === "reject") {
            await emitPart(askPartOf(id, request, "rejected", "reject"));
            return { kind: "denied", feedback: reply.data.feedback };
        }
        await emitPart(askPartOf(id, request, "resolved", reply.data.kind));
        return { kind: "approved" };
    };
}

/** Answer an ask, and send the answer to the workflow that waits for it, in the process that runs that workflow. */
export async function sendAskAnswer(gateway: AskGateway, askId: string, reply: AskReply): Promise<AnswerOutcome> {
    const outcome = await gateway.answer(askId, reply);
    if (outcome !== "applied") return outcome;
    const workflowId = await gateway.workflowOf(askId);
    if (workflowId !== null) await DBOS.send(workflowId, reply, askTopic(askId));
    return outcome;
}
