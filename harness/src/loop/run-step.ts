/**
 * `RunStep` adapters.
 *
 * `runAgent` wraps every LLM and tool call in an injected `RunStep`. Two
 * adapters cover the two execution modes:
 *
 * - `passthroughStep` — the chat route. In-process, single-replica, no
 *   durability. Just runs the function.
 * - `durableStep` — workflow contexts. Wraps the call as a `DBOS.runStep`
 *   so a crashed workflow replays without re-issuing completed LLM/tool
 *   calls. The step name (`llm-${i}`, `tool-${name}-${toolUseId}`) is the
 *   cache key on replay (see the harness-thread-store spec) and must not be reformatted.
 *
 * The loop body never imports DBOS — it depends only on the `RunStep`
 * shape, which is what lets the same `runAgent` serve chat and (in change
 * 8) durable workflows.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Result } from "neverthrow";

import { unwrapOrThrow } from "../lib/result.js";
import type { RunStep } from "./types.js";

export const passthroughStep: RunStep = (_name, fn) => fn();

export const durableStep: RunStep = (name, fn) => DBOS.runStep(fn, { name });

/**
 * Adapt a `RunStep` to a `Result`-returning body. This is THE seam where
 * `Result` meets durability: a step is recorded as failed — and retried /
 * fails fast — only when its body throws, so an `err` MUST become a throw at
 * the step boundary. The body stays Result-shaped; `unwrapOrThrow` isolates
 * the throw. Pass `durableStep` in workflows, `passthroughStep` in chat.
 */
export function resultStep(runStep: RunStep) {
    return <T, E>(
        name: string,
        // `PromiseLike`, not `Promise` — a `ResultAsync` (what `provider.chat`
        // returns) is a `PromiseLike<Result>`, awaited to its inner `Result`.
        fn: () => PromiseLike<Result<T, E>>,
    ): Promise<T> => runStep(name, async () => unwrapOrThrow(await fn()));
}
