/**
 * The input-only rules of the run-event read side, driven with no database and
 * no durability engine: what counts as a deliverable part, and what the
 * reconciling fold does to a batch and to a live stream.
 */

import { describe, expect, it } from "bun:test";

import type { ChatPart } from "../contracts/chat-parts.js";
import { foldRunEventParts, parseRunEventPart, pipeFoldedRunEvents } from "./run-event-parts.js";

const activity = (id: string, phase: string, text: string): ChatPart =>
    ({ type: "data-step-activity", id, runId: "run-1", stepId: "T1S1", phase, activity: text }) as ChatPart;

const summary = (stepId: string, markdown: string): ChatPart => ({
    type: "data-step-summary",
    id: `step-summary-run-1-${stepId}`,
    runId: "run-1",
    stepId,
    agentId: "bio",
    markdown,
});

describe("parseRunEventPart", () => {
    it("accepts a value whose type the part registry classifies", () => {
        const part = parseRunEventPart({ type: "data-run-failed", runId: "run-1", error: "boom" });
        expect(part).toEqual({ type: "data-run-failed", runId: "run-1", error: "boom" });
    });

    it("rejects the workflow-layer envelopes a sandbox step also writes", () => {
        expect(parseRunEventPart({ type: "data-loop-event", data: { stepId: "T1S1", event: {} } })).toBeNull();
        expect(parseRunEventPart({ type: "data-sandbox-event", data: { execId: "e", event: {} } })).toBeNull();
    });

    it("rejects values that carry no usable discriminant", () => {
        expect(parseRunEventPart(null)).toBeNull();
        expect(parseRunEventPart("data-dag-state")).toBeNull();
        expect(parseRunEventPart(42)).toBeNull();
        expect(parseRunEventPart({})).toBeNull();
        expect(parseRunEventPart({ type: 7 })).toBeNull();
    });

    it("rejects a type the registry does not know", () => {
        expect(parseRunEventPart({ type: "data-something-invented", id: "x" })).toBeNull();
    });
});

describe("foldRunEventParts", () => {
    it("collapses a reconciling id to its current value", () => {
        const folded = foldRunEventParts([
            activity("step-activity-run-1-T1S1", "sandbox-init", "Starting sandbox"),
            activity("step-activity-run-1-T1S1", "executing", "Running deseq2.R"),
            activity("step-activity-run-1-T1S1", "complete", "Step complete"),
        ]);

        expect(folded).toEqual([activity("step-activity-run-1-T1S1", "complete", "Step complete")]);
    });

    it("keeps one current value per reconciling id, not one overall", () => {
        const folded = foldRunEventParts([
            activity("step-activity-run-1-T1S1", "executing", "Running deseq2.R"),
            activity("step-activity-run-1-T1S2", "sandbox-init", "Starting sandbox"),
            activity("step-activity-run-1-T1S1", "complete", "Step complete"),
        ]);

        expect(folded).toEqual([
            activity("step-activity-run-1-T1S2", "sandbox-init", "Starting sandbox"),
            activity("step-activity-run-1-T1S1", "complete", "Step complete"),
        ]);
    });

    it("keeps the whole history of a part type that does not reconcile", () => {
        const history = [summary("T1S1", "first"), summary("T1S2", "second"), summary("T1S1", "revised")];

        expect(foldRunEventParts(history)).toEqual(history);
    });

    it("leaves non-reconciling parts in write order around a collapsed id", () => {
        const folded = foldRunEventParts([
            summary("T1S1", "first"),
            activity("step-activity-run-1-T1S1", "executing", "Running deseq2.R"),
            summary("T1S2", "second"),
            activity("step-activity-run-1-T1S1", "complete", "Step complete"),
            summary("T1S3", "third"),
        ]);

        expect(folded).toEqual([
            summary("T1S1", "first"),
            summary("T1S2", "second"),
            activity("step-activity-run-1-T1S1", "complete", "Step complete"),
            summary("T1S3", "third"),
        ]);
    });

    it("does not collapse across part types that share an id", () => {
        const dag = { type: "data-dag-state", id: "shared", runId: "run-1", steps: [] } as ChatPart;
        const ask = { type: "data-ask", id: "shared", title: "t", command: "c", status: "pending" } as ChatPart;

        expect(foldRunEventParts([dag, ask])).toEqual([dag, ask]);
    });

    it("passes through a reconciling part carrying no id rather than dropping it", () => {
        const idless = { type: "data-step-activity", runId: "run-1", stepId: "T1S1", phase: "executing", activity: "x" } as ChatPart;

        expect(foldRunEventParts([idless, idless])).toEqual([idless, idless]);
    });

    it("returns an empty batch unchanged", () => {
        expect(foldRunEventParts([])).toEqual([]);
    });
});

describe("pipeFoldedRunEvents", () => {
    async function* burst<T>(entries: readonly T[]): AsyncIterable<T> {
        yield* entries;
    }

    async function* withGaps<T>(entries: readonly T[], gapMs: number): AsyncIterable<T> {
        for (const [index, entry] of entries.entries()) {
            if (index > 0) await new Promise<void>((resolve) => setTimeout(resolve, gapMs));
            yield entry;
        }
    }

    async function delivered<T>(entries: AsyncIterable<T>, flushMs = 10): Promise<T[]> {
        const out: T[] = [];
        await pipeFoldedRunEvents(
            entries,
            async (entry) => {
                out.push(entry);
            },
            flushMs,
        );
        return out;
    }

    it("delivers a catch-up burst of one key once, with its latest value", async () => {
        const out = await delivered(
            burst([
                activity("step-activity-run-1-T1S1", "sandbox-init", "Starting sandbox"),
                activity("step-activity-run-1-T1S1", "executing", "Running deseq2.R"),
                activity("step-activity-run-1-T1S1", "complete", "Step complete"),
            ]),
        );

        expect(out).toEqual([activity("step-activity-run-1-T1S1", "complete", "Step complete")]);
    });

    it("delivers each key once in a burst, not one key overall", async () => {
        const out = await delivered(
            burst([
                activity("step-activity-run-1-T1S1", "executing", "Running deseq2.R"),
                activity("step-activity-run-1-T1S2", "sandbox-init", "Starting sandbox"),
                activity("step-activity-run-1-T1S1", "complete", "Step complete"),
            ]),
        );

        expect(out).toEqual([
            activity("step-activity-run-1-T1S1", "complete", "Step complete"),
            activity("step-activity-run-1-T1S2", "sandbox-init", "Starting sandbox"),
        ]);
    });

    it("delivers the parts that do not reconcile at once, in write order", async () => {
        const history = [summary("T1S1", "first"), summary("T1S2", "second"), summary("T1S1", "revised")];

        expect(await delivered(burst(history))).toEqual(history);
    });

    it("delivers an entry of a type that the registry does not know at once", async () => {
        const envelope = { type: "data-loop-event", data: { stepId: "T1S1", event: {} } };

        expect(await delivered(burst([envelope, envelope]))).toEqual([envelope, envelope]);
    });

    it("delivers a held entry when the stream ends before the window closes", async () => {
        const out = await delivered(burst([activity("step-activity-run-1-T1S1", "executing", "Running deseq2.R")]), 10_000);

        expect(out).toEqual([activity("step-activity-run-1-T1S1", "executing", "Running deseq2.R")]);
    });

    it("delivers each update of a key when the updates are more than one window apart", async () => {
        const out = await delivered(
            withGaps(
                [
                    activity("step-activity-run-1-T1S1", "executing", "Running deseq2.R"),
                    activity("step-activity-run-1-T1S1", "complete", "Step complete"),
                ],
                50,
            ),
            5,
        );

        expect(out).toEqual([
            activity("step-activity-run-1-T1S1", "executing", "Running deseq2.R"),
            activity("step-activity-run-1-T1S1", "complete", "Step complete"),
        ]);
    });

    it("does not collapse across part types that share an id", async () => {
        const dag = { type: "data-dag-state", id: "shared", runId: "run-1", steps: [] } as ChatPart;
        const ask = { type: "data-ask", id: "shared", title: "t", command: "c", status: "pending" } as ChatPart;

        expect(await delivered(burst([dag, ask]))).toEqual([dag, ask]);
    });

    it("delivers each reconciling part that carries no id", async () => {
        const idless = { type: "data-step-activity", runId: "run-1", stepId: "T1S1", phase: "executing", activity: "x" } as ChatPart;

        expect(await delivered(burst([idless, idless]))).toEqual([idless, idless]);
    });
});
