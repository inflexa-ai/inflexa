/**
 * Test-only `ToolContext` builder. Not a `*.test.ts` file, so the test
 * runner ignores it; imported by the tool unit tests.
 */

import { makeSession } from "../../providers/__fixtures__/session.js";
import { UnavailableAsk } from "../approval/contract.js";
import type { ToolContext } from "../define-tool.js";

/** A `ToolContext` plus the list of events its `emit` recorded. */
export interface TestToolContext {
    readonly ctx: ToolContext;
    /** Every event passed to `ctx.emit`, in call order. */
    readonly emitted: unknown[];
}

/** Build a `ToolContext` for tests; `emit` records into `emitted`. */
export function makeToolContext(signal?: AbortSignal): TestToolContext {
    const emitted: unknown[] = [];
    const deny = new UnavailableAsk();
    const ctx: ToolContext = {
        session: makeSession(),
        signal: signal ?? new AbortController().signal,
        emit: (event) => {
            emitted.push(event);
        },
        runStep: (_name, fn) => fn(),
        ask: (request) => deny.ask(request),
    };
    return { ctx, emitted };
}
