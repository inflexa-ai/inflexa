/**
 * Agent-loop seam — shared types.
 *
 * `runAgent` (run-agent.ts) is a pure-async function: it owns the message
 * loop and nothing else. Durability and streaming are *injected* — a
 * `RunStep` wraps each LLM/tool call (`passthroughStep` for chat, a
 * `DBOS.runStep` wrapper in PR #3) and an `EmitFn` is the flat event sink.
 * The loop body itself knows nothing about DBOS, HTTP, or memory.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

import type { ChatStreamEvent } from "../providers/types.js";
import type { Tool } from "../tools/define-tool.js";

/**
 * A loop message. The harness's working message array is Anthropic-shaped
 * `MessageParam` (see the harness-providers spec) — it holds both assistant replies (appended
 * verbatim from `provider.chat`) and the `user` tool-result messages the
 * loop pushes after each `tool_use` round.
 */
export type LoopMessage = MessageParam;

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
      }
    | {
          readonly type: "tool-finished";
          readonly source: EventSource;
          readonly toolUseId: string;
          readonly name: string;
          readonly isError: boolean;
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
