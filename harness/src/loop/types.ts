/**
 * The shared types of the agent loop: the definition of an agent, its
 * messages, and the flat event sink.
 */

import type { ModelMessage } from "ai";

import type { ToolCallDetail, ToolCallValue, ToolOutcome } from "../contracts/chat-events.js";
import type { ChatStreamEvent, ProviderOptions } from "../providers/types.js";
import type { Tool } from "../tools/define-tool.js";
import type { CompactionRules } from "./compaction.js";
import type { ScriptRuntime } from "../tools/script/run-script.js";
import type { ScriptScratch } from "../tools/script/scratch.js";

/**
 * A loop message. The harness's working message array is AI SDK-shaped
 * `ModelMessage`.
 */
export type LoopMessage = ModelMessage;

/**
 * Everything the loop needs to drive one agent: identity, the system
 * prompt, the model id (provenance / metric label — the `ChatProvider`
 * owns the wire model), the tool surface, and the runaway-guard cap.
 */
export type AgentDefinition = {
    readonly id: string;
    readonly systemPrompt: string;
    readonly model: string;
    readonly tools: readonly Tool[];
    /**
     * The tools that the agent calls from a script, through the one `run_script` tool that the loop adds. A request
     * declares only `run_script`, with one catalog line for each of them, thus their full descriptions stay out of
     * the context until a script asks for one. Each must ask no approval and start no workflow, because a script runs
     * as one step. A step that did not complete runs its script again, thus a tool that writes must accept the same
     * write again. Absent or empty: the agent has no `run_script`.
     */
    readonly scriptTools?: readonly Tool[];
    /** Where the VM of `run_script` comes from. Absent: the VM loads from `node_modules`. */
    readonly scriptRuntime?: ScriptRuntime;
    /** The scratch directory of the scripts of the agent. Absent: no script is saved, and no script writes a file. */
    readonly scriptScratch?: ScriptScratch;
    /** Runaway guard: the cap of model requests of one run. The run ends at the cap. */
    readonly maxIterations: number;
    /** The compaction rules of an agent that a chat thread runs. Absent: the conversation never compacts. */
    readonly compaction?: CompactionRules;
    /**
     * Provider options that each request of the agent sends, beside the options of
     * the provider. They are part of the agent, thus each request of a
     * conversation sends the same options.
     */
    readonly providerOptions?: ProviderOptions;
};

/**
 * Provenance stamped onto every orchestration event — the agent call
 * chain at the point of emission, derived from the `Session` (see the harness-durable-runtime spec).
 * `callPath` is provenance only; nothing branches on it.
 */
export type EventSource = {
    readonly agentId: string;
    readonly callPath: readonly string[];
    /** The id of the tool call that runs this loop. For a data profile, the workflow id of its attempt. */
    readonly invocationId?: string;
};

/**
 * Orchestration events the loop emits: iteration boundaries and tool-call
 * lifecycle. Distinct from `ChatStreamEvent` (model-output text deltas) —
 * the chat route folds both into one `EmitFn` sink.
 */
export type EmitEvent =
    | {
          readonly type: "iteration";
          readonly source: EventSource;
          /** Zero-based. A follow-up request counts from 0. */
          readonly index: number;
          /** True when this request produced the terminal reply of the loop. */
          readonly final: boolean;
      }
    | {
          readonly type: "tool-started";
          readonly source: EventSource;
          readonly toolUseId: string;
          readonly name: string;
          /**
           * One line naming what this call is doing, from the tool's own
           * `describeCall` hook. Absent — never empty — when the tool declares no
           * hook or the detail could not be produced (see `tool-detail.ts`).
           */
          readonly detail?: ToolCallDetail;
          /** The input that the view of the tool declares, with each listed secret form removed and a cap. Absent for a call that is not a root call. */
          readonly input?: ToolCallValue;
      }
    | {
          readonly type: "tool-finished";
          readonly source: EventSource;
          readonly toolUseId: string;
          readonly name: string;
          /**
           * How the call ended. Three states rather than an error boolean: a
           * denial is the user's decision, not a fault, and the loop already
           * treats the two differently in control flow.
           */
          readonly outcome: ToolOutcome;
          /** The same detail the matching `tool-started` carried. */
          readonly detail?: ToolCallDetail;
          /**
           * The time of this call itself, in milliseconds, measured inside its
           * step. A refused call did not run, thus it has no figure, and a host
           * can fall back to its own observation.
           */
          readonly durationMs?: number;
          /** The input again: a replay of a tool step does not give its `tool-started`. */
          readonly input?: ToolCallValue;
          /** The result of a call with the outcome `ok`. */
          readonly result?: ToolCallValue;
          /** The error text of a call with the outcome `error`. */
          readonly error?: ToolCallValue;
      }
    | {
          /** The display recorder of a chat turn emits it, not the loop. See `MessageStartEvent`. */
          readonly type: "message-start";
          readonly source: EventSource;
          readonly messageId: string;
          readonly role: "user";
          readonly text: string;
      }
    | {
          readonly type: "message-start";
          readonly source: EventSource;
          readonly messageId: string;
          readonly role: "assistant";
      };

/**
 * A UI presentation event a tool streams to chat — an AI-SDK `data-*`
 * part whose payload the frontend renders (file references, plan cards,
 * synthesized content). The loop and `emit` are agnostic to the payload
 * shape; the typed contract lives in `harness/contracts`.
 */
export type ChatDataPart = {
    readonly type: `data-${string}`;
    readonly data: unknown;
    /**
     * Emitting-agent provenance, for the SSE route's depth filter (it drops
     * sub-agent display parts the same way it drops sub-agent tool events).
     * Omitted by emitters outside the chat loop (workflow parts carry their own
     * routing envelopes).
     */
    readonly source?: EventSource;
    /**
     * Live only. Inside a tool step the chat stream writes the part as progress: a live reader gets it, and the step
     * does not checkpoint it. Give it to a copy that a later part of the same reconciling id replaces.
     */
    readonly transient?: boolean;
};

/**
 * The flat event sink. One function reference flows unchanged through
 * every nesting level. It carries three event categories: orchestration
 * events (`EmitEvent`, from the loop), model-output deltas
 * (`ChatStreamEvent`, from the provider), and UI presentation parts
 * (`ChatDataPart`, from tools). A tool that does not stream never calls it.
 */
export type EmitFn = (event: EmitEvent | ChatStreamEvent | ChatDataPart) => void | Promise<void>;
