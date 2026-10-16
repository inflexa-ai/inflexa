/**
 * Test-only `ToolContext` builder. Not a `*.test.ts` file, so the test
 * runner ignores it; imported by the tool unit tests.
 */

import { makeSession } from "../../providers/__fixtures__/session.js";
import type { ChatStreamEvent } from "../../providers/types.js";
import { UnavailableAsk } from "../approval/contract.js";
import type { ToolContext } from "../define-tool.js";
import type { ChatDataPart, EmitEvent } from "../../loop/types.js";

/** A `ToolContext` plus the list of events its `emit` recorded. */
export type TestToolContext = {
    readonly ctx: ToolContext;
    /** Every event passed to `ctx.emit`, in call order, as the `emit` seam declares them. */
    readonly emitted: Array<EmitEvent | ChatStreamEvent | ChatDataPart>;
};

/** Build a `ToolContext` for tests; `emit` records into `emitted`. */
export function makeToolContext(signal?: AbortSignal): TestToolContext {
    const emitted: Array<EmitEvent | ChatStreamEvent | ChatDataPart> = [];
    const deny = new UnavailableAsk();
    const ctx: ToolContext = {
        invocationId: "test-tool-call",
        session: makeSession(),
        signal: signal ?? new AbortController().signal,
        emit: (event) => {
            emitted.push(event);
        },
        ask: (request) => deny.ask(request),
    };
    return { ctx, emitted };
}

/** The `data-*` part arm of an emitted event, failing the test on the other arms. */
export function dataPartOf(event: EmitEvent | ChatStreamEvent | ChatDataPart): ChatDataPart {
    if (!("data" in event)) throw new Error(`expected a data-* part, got type ${event.type}`);
    return event;
}
