/**
 * The recording knowledge client of the evaluation: a `KnowledgeClient` that
 * forwards every call to the inner client and pushes one `KnowledgeCall` per
 * call into the sink of the run. The answer reaches the caller exactly as the
 * inner client gave it. The record keeps a trimmed copy.
 *
 * The runner owns the client it hands the planner, and the loop event of a
 * tool call carries no output, thus the seam of the client is the one place
 * where the response of the service can be recorded without a harness change.
 * The same wrapper serves the planner and the sandbox agents of the headless
 * runner: any operation the inner client has beyond the three recorded ones
 * is forwarded as it is.
 */

import { createHash } from "node:crypto";

import type { KnowledgeClient } from "@inflexa-ai/harness";

import type { KnowledgeCall, KnowledgeOp } from "./record.js";

/** Where the calls land. An array of `KnowledgeCall` is a sink. */
export interface KnowledgeCallSink {
    readonly length: number;
    push(call: KnowledgeCall): unknown;
}

type Loose = Record<string, unknown>;

function isObject(value: unknown): value is Loose {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The listed keys of `value`, in order, with an absent key left out. */
function pick(value: Loose, keys: readonly string[]): Loose {
    const out: Loose = {};
    for (const key of keys) if (value[key] !== undefined) out[key] = value[key];
    return out;
}

function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function trimRecommend(response: Loose): Loose {
    const out = pick(response, ["match", "snapshot", "situation"]);
    if (Array.isArray(response.procedure)) {
        out.procedure = response.procedure.map((step: unknown) => {
            if (!isObject(step)) return step;
            const trimmed = pick(step, ["step"]);
            if (isObject(step.method) && step.method.id !== undefined) trimmed.method = { id: step.method.id };
            return { ...trimmed, ...pick(step, ["template", "rules", "flags"]) };
        });
    }
    if (Array.isArray(response.claims)) {
        out.claims = response.claims.map((claim: unknown) => (isObject(claim) ? pick(claim, ["id"]) : claim));
    }
    return { ...out, ...pick(response, ["flags", "dropped", "uncovered"]) };
}

function trimCheck(response: Loose): Loose {
    return pick(response, ["ok", "snapshot", "violations", "warnings", "not_assessed"]);
}

function trimRender(response: Loose): Loose {
    const out = pick(response, ["snapshot", "template", "slots", "decision_record"]);
    if (typeof response.script === "string") out.script_sha256 = sha256(response.script);
    return out;
}

/**
 * The recorded form of one answer. An unavailable or a rejected answer is
 * small and is kept whole; a data answer keeps the evidence and drops the
 * prose and the script body.
 */
export function trimResponse(op: KnowledgeOp, response: unknown): unknown {
    if (!isObject(response)) return response;
    if (response.match === "unavailable" || response.match === "rejected") return response;
    if (op === "recommend") return trimRecommend(response);
    if (op === "check") return trimCheck(response);
    return trimRender(response);
}

/**
 * Wrap `inner` so each `recommend`, `check`, and `render` call lands in
 * `sink` as one `KnowledgeCall`, then answers exactly as the inner client did.
 * A thrown call is recorded as `{ thrown }` and thrown again.
 */
export function recordingKnowledgeClient(inner: KnowledgeClient, sink: KnowledgeCallSink): KnowledgeClient {
    async function record<T>(op: KnowledgeOp, request: unknown, call: () => Promise<T>): Promise<T> {
        const started = performance.now();
        let response: T;
        try {
            response = await call();
        } catch (caught) {
            const message = caught instanceof Error ? caught.message : String(caught);
            sink.push({ seq: sink.length + 1, op, request, response: { thrown: message }, responseChars: 0, elapsedMs: Math.round(performance.now() - started) });
            throw caught;
        }
        const elapsedMs = Math.round(performance.now() - started);
        const text = JSON.stringify(response);
        sink.push({ seq: sink.length + 1, op, request, response: trimResponse(op, response), responseChars: text === undefined ? 0 : text.length, elapsedMs });
        return response;
    }
    return {
        ...inner,
        recommend: (situation, responseFormat, preferences) =>
            record(
                "recommend",
                { situation, ...(responseFormat ? { response_format: responseFormat } : {}), ...(preferences ? { preferences } : {}) },
                () => inner.recommend(situation, responseFormat, preferences),
            ),
        check: (situation, steps) => record("check", { situation, steps }, () => inner.check(situation, steps)),
        render: (template, slots, farm) => record("render", { template, slots, ...(farm ? { farm } : {}) }, () => inner.render(template, slots, farm)),
    };
}
