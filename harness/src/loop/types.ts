/**
 * Agent-loop seam — shared types.
 *
 * `runAgent` (run-agent.ts) is a pure-async function: it owns the message
 * loop and nothing else. Durability and streaming are *injected* — a
 * `RunStep` wraps each LLM/tool call (`passthroughStep` for chat, a
 * `DBOS.runStep` wrapper in PR #3) and an `EmitFn` is the flat event sink.
 * The loop body itself knows nothing about DBOS, HTTP, or memory.
 */

import type { ModelMessage } from "ai";

import type { ToolCallDetail, ToolOutcome } from "../contracts/chat-events.js";
import type { ChatStreamEvent } from "../providers/types.js";
import type { Tool } from "../tools/define-tool.js";

/**
 * A loop message. The harness's working message array is AI SDK-shaped
 * `ModelMessage`.
 */
export type LoopMessage = ModelMessage;

/**
 * Everything `runAgent` needs to drive one agent: identity, the system
 * prompt, the model id (provenance / metric label — the `ChatProvider`
 * owns the wire model), the tool surface, and the runaway-guard cap.
 */
export interface AgentDefinition {
    readonly id: string;
    readonly systemPrompt: string;
    readonly model: string;
    readonly tools: readonly Tool[];
    /** Runaway guard — at the cap the loop forces a tool-less wrap-up call. */
    readonly maxIterations: number;
}

/**
 * The durability seam. `passthroughStep` (`(_, fn) => fn()`) in the chat
 * route; a `DBOS.runStep` wrapper in PR #3. The loop is agnostic — it only
 * promises a deterministic `name` per call (the step-naming contract).
 */
export type RunStep = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/**
 * Provenance stamped onto every orchestration event — the agent call
 * chain at the point of emission, derived from the `Session` (see the harness-durable-runtime spec).
 * `callPath` is provenance only; nothing branches on it.
 */
export interface EventSource {
    readonly agentId: string;
    readonly callPath: readonly string[];
}

/**
 * Orchestration events the loop emits: iteration boundaries and tool-call
 * lifecycle. Distinct from `ChatStreamEvent` (model-output text deltas) —
 * the chat route folds both into one `EmitFn` sink.
 */
export type EmitEvent =
    | {
          readonly type: "iteration";
          readonly source: EventSource;
          /** Zero-based iteration index; equals `maxIterations` for the wrap-up. */
          readonly index: number;
          /** True when this iteration produced the loop's terminal reply. */
          readonly final: boolean;
      }
    | {
          readonly type: "tool-started";
          readonly source: EventSource;
          readonly toolUseId: string;
          readonly name: string;
          readonly input: unknown;
          /**
           * One line naming what this call is doing, from the tool's own
           * `describeCall` hook. Absent — never empty — when the tool declares no
           * hook or the detail could not be produced (see `tool-detail.ts`).
           */
          readonly detail?: ToolCallDetail;
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
           * The time around this call's own dispatch, in milliseconds.
           *
           * A host cannot measure this itself. The loop emits every
           * `tool-started` of a round before it dispatches anything, and every
           * `tool-finished` after the round settles. Thus a host that brackets
           * the two events measures the round, and each call of a multi-call
           * round reports the same figure.
           *
           * The field is optional, and it is absent when no measurement was
           * taken. As a result a host can fall back to its own observation.
           */
          readonly durationMs?: number;
      };

/**
 * A UI presentation event a tool streams to chat — an AI-SDK `data-*`
 * part whose payload the frontend renders (file references, plan cards,
 * synthesized content). The loop and `emit` are agnostic to the payload
 * shape; the typed contract lives in `harness/contracts`.
 */
export interface ChatDataPart {
    readonly type: `data-${string}`;
    readonly data: unknown;
    /**
     * Emitting-agent provenance, for the SSE route's depth filter (it drops
     * sub-agent display parts the same way it drops sub-agent tool events).
     * Omitted by emitters outside the chat loop (workflow parts carry their own
     * routing envelopes).
     */
    readonly source?: EventSource;
}

/**
 * The flat event sink. One function reference flows unchanged through
 * every nesting level. It carries three event categories: orchestration
 * events (`EmitEvent`, from the loop), model-output deltas
 * (`ChatStreamEvent`, from the provider), and UI presentation parts
 * (`ChatDataPart`, from tools). A tool that does not stream never calls it.
 */
export type EmitFn = (event: EmitEvent | ChatStreamEvent | ChatDataPart) => void | Promise<void>;
