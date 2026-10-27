/**
 * A sub-agent as a child workflow.
 *
 * Inside the body of a workflow, a tool that runs a sub-agent starts one child
 * workflow for each call, with the id `${workflowId}-${toolCallId}`. Each model
 * call and each tool call of the sub-agent is then a step of the child, thus a
 * recovery repeats no completed call, and two sub-agents of one reply run at the
 * same time. A replay of the caller finds the same child by its id.
 *
 * The child writes its frames to its own durable stream, and the stream of the
 * caller names the child, thus the reader of a turn merges the two. The child
 * gives its usage back in its result, and the caller adds it to the total of the
 * turn. Its input holds no credential of a request: the child of a chat turn
 * asks for the credential of its root turn, and the child of a run gets the
 * mandate that its run session carries.
 *
 * Outside a workflow, and inside a step, which cannot start a workflow, the tool
 * runs the body of the sub-agent in its own process.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import { closeDurableStream } from "@dbos-inc/vercel-ai";
import type { LanguageModelMiddleware } from "ai";

import type { AgentSession, AuthContext, Identity, Provenance, RunFrame, Scope } from "../auth/types.js";
import type { ChatFrame, ChatPartFrame } from "../contracts/chat-events.js";
import { createSubAgentActivityTracker } from "../contracts/subagent-activity.js";
import type { ToolContext } from "../tools/define-tool.js";
import { CHAT_STREAM_KEY, createTurnStreamWriter, SUB_AGENT_STREAM_PART } from "./chat-stream.js";
import { addChatUsage, type AgentRunUsage } from "./metrics.js";
import type { LoopOptions } from "./run-loop.js";
import { currentRootTurn, turnCredentials, withRootTurn } from "./turn-credentials.js";

/** The options of the loop of a sub-agent that the place where it runs decides. */
export type SubAgentLoopOptions = Pick<LoopOptions, "signal" | "emit" | "toolWriter" | "invocationId" | "turnUsage" | "modelMiddleware">;

/** One call of a sub-agent, as its body sees it. */
export type SubAgentCall<P> = {
    readonly payload: P;
    /** The context of the call. Its session is the session of the caller. */
    readonly ctx: ToolContext;
    /** Spread these into the options of each loop of the body. */
    readonly loop: SubAgentLoopOptions;
    /** Run a read or a write of the body once: a step in a child workflow, a plain call in a process. */
    readonly durably: <T>(name: string, run: () => Promise<T>) => Promise<T>;
};

export type SubAgentBody<P, R> = (call: SubAgentCall<P>) => Promise<R>;

/** The function that the tool of a sub-agent calls. */
export type SubAgent<P, R> = (payload: P, ctx: ToolContext) => Promise<R>;

/** Make the function of a sub-agent from its name and its body: {@link registerSubAgent}, or {@link inProcessSubAgent}. */
export type SubAgentRegistrar = <P, R>(name: string, body: SubAgentBody<P, R>) => SubAgent<P, R>;

type SubAgentInput<P> = {
    readonly payload: P;
    readonly invocationId: string;
    readonly identity: Identity;
    readonly scope: Scope;
    readonly provenance: Provenance;
    readonly runFrame?: RunFrame;
    /** The mandate of a run session, which can go into a workflow input. A chat turn gives none. */
    readonly auth?: AuthContext;
    readonly rootTurnId?: string;
};

type ChildEnd<R> = {
    readonly result: R;
    /** The usage of the whole sub-agent, each of its own sub-agents included. */
    readonly turnUsage: AgentRunUsage;
    /** The last sub-agent activity of the call, for the display of the caller. */
    readonly activity?: ChatPartFrame;
};

/** A middleware that fails each model call of a child with no credential, before it reaches the provider. */
function missingCredentialGuard(): LanguageModelMiddleware {
    const fail = (): Promise<never> =>
        Promise.reject(Object.assign(new Error("The sub-agent has no credential of its user."), { name: "TurnCredentialMissingError" }));
    return { specificationVersion: "v4", wrapStream: fail, wrapGenerate: fail };
}

/**
 * Run a sub-agent in the process of its caller, with no workflow: its loops fold their usage into the total of the
 * caller. A tool factory that a test builds many times takes this registrar, because DBOS registers a name one time.
 */
export function inProcessSubAgent<P, R>(_name: string, body: SubAgentBody<P, R>): SubAgent<P, R> {
    return (payload, ctx) =>
        body({
            payload,
            ctx,
            loop: { signal: ctx.signal, emit: ctx.emit, invocationId: ctx.invocationId, turnUsage: ctx.turnUsage },
            durably: (_name, run) => run(),
        });
}

/**
 * Register a sub-agent as a child workflow, and give the function that its tool calls. Call it one time for each
 * process, before DBOS launches, because DBOS finds the workflow of a recovery by its registered name.
 */
export function registerSubAgent<P, R>(name: string, body: SubAgentBody<P, R>): SubAgent<P, R> {
    const workflow = DBOS.registerWorkflow(
        async (input: SubAgentInput<P>): Promise<ChildEnd<R>> => {
            const auth = input.auth ?? (input.rootTurnId === undefined ? undefined : turnCredentials.of(input.rootTurnId));
            const session: AgentSession = {
                identity: input.identity,
                scope: input.scope,
                provenance: input.provenance,
                runFrame: input.runFrame,
                // A child with no credential makes no model call, thus no adapter reads the empty value.
                auth: auth ?? {},
            };
            // The input holds the provenance of the caller. The body of the sub-agent extends it.
            const caller = { agentId: input.provenance.agentId, callPath: [...input.provenance.callPath] };
            const tracker = createSubAgentActivityTracker();
            // The tracker reads the call of the caller first, thus the activity of the child belongs to that call.
            tracker.track({ type: "tool-started", toolUseId: input.invocationId, name, source: caller }, Date.now());
            let activity: ChatPartFrame | undefined;
            const observe = (frame: ChatFrame): void => {
                activity = tracker.track(frame, Date.now()) ?? activity;
            };
            const writer = createTurnStreamWriter(caller, observe);
            // A recovered child replays its model calls, and the usage middleware adds each one again. Thus the total
            // covers the whole child, also after a crash.
            const turnUsage: AgentRunUsage = {};
            // A stop of the caller cancels the child workflow, thus the child has no signal of its own.
            const signal = new AbortController().signal;
            const run = (): Promise<R> =>
                body({
                    payload: input.payload,
                    ctx: { invocationId: input.invocationId, session, signal, emit: writer.emit, turnUsage },
                    // The text of a sub-agent reaches no surface, thus its model calls write no text to the stream.
                    loop: {
                        signal,
                        emit: writer.emit,
                        toolWriter: writer.toolWriter,
                        invocationId: input.invocationId,
                        turnUsage,
                        modelMiddleware: auth === undefined ? [missingCredentialGuard()] : undefined,
                    },
                    durably: (stepName, step) => DBOS.runStep(step, { name: stepName }),
                });
            const result = input.rootTurnId === undefined ? await run() : await withRootTurn(input.rootTurnId, run);
            await writer.settle();
            await closeDurableStream(CHAT_STREAM_KEY, "stop");
            return { result, turnUsage, activity };
        },
        { name: `sub-agent.${name}` },
    );
    const inProcess = inProcessSubAgent(name, body);

    return async (payload, ctx) => {
        if (!DBOS.isInWorkflow() || DBOS.isInStep()) return inProcess(payload, ctx);
        const parentId = DBOS.workflowID;
        if (parentId === undefined) throw new Error("A workflow body runs with no workflow id.");
        const childId = `${parentId}-${ctx.invocationId}`;
        const { auth, ...session } = ctx.session;
        const input: SubAgentInput<P> = {
            payload,
            invocationId: ctx.invocationId,
            identity: session.identity,
            scope: session.scope,
            provenance: session.provenance,
            runFrame: session.runFrame,
            // Only the mandate of a run can go into a workflow input. The credential of a request never does.
            auth: session.runFrame === undefined ? undefined : auth,
            rootTurnId: currentRootTurn(),
        };
        // The start and the wait take their function ids before the first await, thus the parallel calls of one
        // reply keep their order on a replay, and each call finds its own child.
        const started = DBOS.startWorkflow(workflow, { workflowID: childId })(input);
        const ended = DBOS.getResult<ChildEnd<R>>(childId);
        const named = ctx.emit({ type: SUB_AGENT_STREAM_PART, data: { workflowId: childId } });
        const stop = (): void => {
            // A failed cancel leaves the child to run to its end, and the wait below then reads its result.
            started.then(() => DBOS.cancelWorkflow(childId, { cancelChildren: true })).catch(() => undefined);
        };
        ctx.signal.addEventListener("abort", stop, { once: true });
        try {
            // One wait reads the three, thus a cancel that ends the start or the name leaves no rejection unread.
            const [, end] = await Promise.all([started, ended, named]);
            if (end === null) throw new Error(`The sub-agent ${name} gave no result.`);
            if (ctx.turnUsage !== undefined) addChatUsage(ctx.turnUsage, end.turnUsage);
            if (end.activity !== undefined) await ctx.emit({ type: end.activity.type, data: end.activity });
            return end.result;
        } catch (err) {
            // A stop of the turn cancels the child, and the turn reads the stop, not the cancel of the child.
            if (ctx.signal.aborted) throw ctx.signal.reason ?? new DOMException("The turn was stopped.", "AbortError");
            throw err;
        } finally {
            ctx.signal.removeEventListener("abort", stop);
        }
    };
}
