import { describe, expect, test } from "bun:test";
import type { EmitFn, EventSource } from "@inflexa-ai/harness";

import { createChatPrinter, isSubAgentEvent, readPlanCard, readRunCard, type ChatSink } from "./chat_printer.ts";

/**
 * A recording sink + printer. `out()` accumulates conversation output; `errs`
 * accumulates diagnostics. `emit` is wrapped to a `void` return — the printer's
 * emit is synchronous, but `EmitFn`'s declared type is `void | Promise<void>`,
 * so the wrapper keeps the call sites free of floating-promise noise.
 */
function harness(): { emit: (e: Parameters<EmitFn>[0]) => void; finishTurn: (t?: string) => void; out: () => string; errs: string[] } {
    const outChunks: string[] = [];
    const errs: string[] = [];
    const sink: ChatSink = { out: (s) => outChunks.push(s), errLine: (s) => errs.push(s) };
    const printer = createChatPrinter(sink);
    return { emit: (e) => void printer.emit(e), finishTurn: printer.finishTurn, out: () => outChunks.join(""), errs };
}

/** Top-level provenance (callPath length 1) — passes the sub-agent depth filter. */
const TOP: EventSource = { agentId: "cli-chat", callPath: ["cli-chat"] };
/** Sub-agent provenance (callPath length 2) — dropped by the depth filter. */
const SUB: EventSource = { agentId: "planner", callPath: ["cli-chat", "planner"] };

describe("createChatPrinter", () => {
    test("text-delta accumulates verbatim, no pacing", () => {
        const h = harness();
        h.emit({ type: "text-delta", text: "he" });
        h.emit({ type: "text-delta", text: "llo wor" });
        h.emit({ type: "text-delta", text: "ld" });
        expect(h.out()).toBe("hello world");
    });

    test("sub-agent traffic (callPath deeper than top level) is dropped", () => {
        const h = harness();
        h.emit({ type: "tool-started", source: SUB, toolUseId: "t1", name: "grep", input: {} });
        h.emit({ type: "tool-finished", source: SUB, toolUseId: "t1", name: "grep", isError: false });
        h.emit({ type: "data-plan", source: SUB, data: { planId: "pln-deadbeef", title: "hidden", steps: [] } });
        expect(h.out()).toBe("");
        expect(h.errs).toEqual([]);
    });

    test("tool chip: one line on start, outcome on finish", () => {
        const h = harness();
        h.emit({ type: "tool-started", source: TOP, toolUseId: "t1", name: "grep", input: { q: "gene" } });
        h.emit({ type: "tool-finished", source: TOP, toolUseId: "t1", name: "grep", isError: false });
        const out = h.out();
        expect(out).toContain("[tool] grep running...");
        expect(out).toContain("[tool] grep done");
    });

    test("tool chip: error outcome is marked", () => {
        const h = harness();
        h.emit({ type: "tool-started", source: TOP, toolUseId: "t1", name: "read_file", input: {} });
        h.emit({ type: "tool-finished", source: TOP, toolUseId: "t1", name: "read_file", isError: true });
        expect(h.out()).toContain("[tool] read_file error");
    });

    test("data-plan renders id, title, and per-step lines", () => {
        const h = harness();
        h.emit({
            type: "data-plan",
            source: TOP,
            data: {
                id: "pres-1",
                planId: "pln-abc12345",
                title: "Differential expression",
                steps: [
                    { id: "T1S1", name: "align", agent: "scientific-executor" },
                    { id: "T1S2", name: "quantify", agent: "scientific-executor" },
                ],
            },
        });
        const out = h.out();
        expect(out).toContain("[plan] Differential expression (pln-abc12345)");
        expect(out).toContain("- T1S1 align [scientific-executor]");
        expect(out).toContain("- T1S2 quantify [scientific-executor]");
    });

    test("data-plan falls back to planId as heading when title is absent", () => {
        const h = harness();
        h.emit({ type: "data-plan", source: TOP, data: { planId: "pln-abc12345", steps: [] } });
        expect(h.out()).toContain("[plan] pln-abc12345 (pln-abc12345)");
    });

    test("data-run-card renders run id, title, and step count", () => {
        const h = harness();
        h.emit({ type: "data-run-card", source: TOP, data: { id: "pres-r", runId: "run-xyz", planId: "pln-abc12345", title: "DE run", stepCount: 3 } });
        expect(h.out()).toContain("[run] run-xyz: DE run (3 step(s))");
    });

    test("unknown conversation parts print a one-line tagged mention, not swallowed", () => {
        const h = harness();
        h.emit({ type: "data-presentation", source: TOP, data: { id: "x", content: { kind: "markdown", body: "hi" } } });
        expect(h.out()).toContain("[part:data-presentation]");
    });

    test("copy-on-receive: mutating a part after emit does not change output", () => {
        const h = harness();
        const data: { planId: string; title: string; steps: { id: string; name: string; agent: string }[] } = {
            planId: "pln-abc12345",
            title: "Original",
            steps: [{ id: "S1", name: "one", agent: "a1" }],
        };
        h.emit({ type: "data-plan", source: TOP, data });
        const snapshot = h.out();
        // Mutate the exact object handed to emit — the in-process emit hazard.
        data.title = "MUTATED";
        data.steps.push({ id: "S2", name: "two", agent: "a2" });
        data.steps[0]!.name = "CHANGED";
        expect(h.out()).toBe(snapshot);
        expect(snapshot).toContain("[plan] Original");
        expect(snapshot).not.toContain("MUTATED");
        expect(snapshot).not.toContain("S2");
    });

    test("finishTurn renders the final answer only when nothing streamed", () => {
        const streamed = harness();
        streamed.emit({ type: "text-delta", text: "streamed answer" });
        streamed.finishTurn("final answer");
        expect(streamed.out()).toContain("streamed answer");
        expect(streamed.out()).not.toContain("final answer");

        const silent = harness();
        silent.finishTurn("the whole answer");
        expect(silent.out()).toContain("the whole answer");
    });

    test("finishTurn closes a tool chip left open by an aborted turn", () => {
        const h = harness();
        h.emit({ type: "tool-started", source: TOP, toolUseId: "t1", name: "grep", input: {} });
        h.finishTurn();
        expect(h.out()).toContain("[tool] grep interrupted");
    });

    test("per-turn state resets between turns", () => {
        const h = harness();
        h.emit({ type: "text-delta", text: "turn one" });
        h.finishTurn("ignored because streamed");
        // Second turn streams nothing — the fallback must render (streamedText was reset).
        h.finishTurn("turn two answer");
        expect(h.out()).toContain("turn one");
        expect(h.out()).toContain("turn two answer");
    });

    test("an unhandled data part prints its [part:<type>] tag, not swallowed", () => {
        const h = harness();
        // A `data-*` type the render switch has no case for hits the catch-all.
        h.emit({ type: "data-widget", source: TOP, data: { anything: true } });
        expect(h.out()).toContain("[part:data-widget]");
    });

    test("tool-finished with no prior tool-started renders without a duration suffix", () => {
        const h = harness();
        // No matching `tool-started` → no start time to diff → no "(…)" suffix, no throw.
        h.emit({ type: "tool-finished", source: TOP, toolUseId: "orphan", name: "grep", isError: false });
        const out = h.out();
        expect(out).toContain("[tool] grep done");
        expect(out).not.toContain("(");
    });

    test("tool chip duration: sub-second renders ms, >= 1s renders seconds", () => {
        // formatMs branches on the Date.now() delta between start and finish. Stub
        // the clock to control the measured elapsed time; restore it in finally.
        const realNow = Date.now;
        let clock = 0;
        Date.now = () => clock;
        try {
            const h = harness();
            clock = 1000;
            h.emit({ type: "tool-started", source: TOP, toolUseId: "fast", name: "grep", input: {} });
            clock = 1300; // 300ms elapsed → the `ms` branch
            h.emit({ type: "tool-finished", source: TOP, toolUseId: "fast", name: "grep", isError: false });
            clock = 2000;
            h.emit({ type: "tool-started", source: TOP, toolUseId: "slow", name: "align", input: {} });
            clock = 4500; // 2500ms elapsed → the `s` branch
            h.emit({ type: "tool-finished", source: TOP, toolUseId: "slow", name: "align", isError: false });
            const out = h.out();
            expect(out).toContain("[tool] grep done (300ms)");
            expect(out).toContain("[tool] align done (2.5s)");
        } finally {
            Date.now = realNow;
        }
    });

    test("copy-on-receive: mutating a run card after emit does not change output", () => {
        const h = harness();
        const data: { runId: string; title: string; stepCount: number } = { runId: "run-xyz", title: "Original", stepCount: 3 };
        h.emit({ type: "data-run-card", source: TOP, data });
        const snapshot = h.out();
        // Mutate the exact object handed to emit — the in-process emit hazard.
        data.title = "MUTATED";
        data.stepCount = 99;
        expect(h.out()).toBe(snapshot);
        expect(snapshot).toContain("[run] run-xyz: Original (3 step(s))");
        expect(snapshot).not.toContain("MUTATED");
        expect(snapshot).not.toContain("99");
    });
});

// The classification pieces the TUI adapter reuses instead of duplicating (D3).
describe("isSubAgentEvent", () => {
    test("top-level provenance (callPath length 1) is NOT sub-agent", () => {
        expect(isSubAgentEvent({ type: "tool-started", source: TOP, toolUseId: "t1", name: "grep", input: {} })).toBe(false);
    });

    test("deeper provenance (callPath length > 1) IS sub-agent", () => {
        expect(isSubAgentEvent({ type: "tool-started", source: SUB, toolUseId: "t1", name: "grep", input: {} })).toBe(true);
    });

    test("an event with no source (a text delta) is never sub-agent", () => {
        expect(isSubAgentEvent({ type: "text-delta", text: "hi" })).toBe(false);
    });

    test("a malformed source lacking a callPath array falls through as top-level", () => {
        // `callPath` is external/loop-owned; a non-array must be treated as
        // top-level rather than throwing (the Array.isArray guard).
        const malformed = {
            type: "tool-started",
            source: { agentId: "x", callPath: undefined },
            toolUseId: "t1",
            name: "grep",
            input: {},
        } as unknown as Parameters<EmitFn>[0];
        expect(isSubAgentEvent(malformed)).toBe(false);
    });
});

describe("readPlanCard", () => {
    test("extracts planId, title, and per-step fields", () => {
        const card = readPlanCard({ id: "pres-1", planId: "pln-abc", title: "DE", steps: [{ id: "S1", name: "align", agent: "exec" }] });
        expect(card).toEqual({ planId: "pln-abc", title: "DE", steps: [{ id: "S1", name: "align", agent: "exec" }] });
    });

    test("coerces missing/mistyped fields to empty rather than throwing", () => {
        // Missing title/steps and a non-string planId all collapse to empties.
        const card = readPlanCard({ planId: 42, steps: "not-an-array" });
        expect(card).toEqual({ planId: "", title: "", steps: [] });
    });

    test("copies each step — no reference to the source data survives", () => {
        const steps = [{ id: "S1", name: "one", agent: "a1" }];
        const card = readPlanCard({ planId: "pln-abc", steps });
        steps[0]!.name = "MUTATED";
        expect(card.steps[0]!.name).toBe("one");
    });
});

describe("readRunCard", () => {
    test("extracts runId, title, and stepCount", () => {
        expect(readRunCard({ id: "pres-r", runId: "run-xyz", planId: "pln-abc", title: "DE run", stepCount: 3 })).toEqual({
            runId: "run-xyz",
            title: "DE run",
            stepCount: 3,
        });
    });

    test("coerces missing/mistyped fields to empty/zero rather than throwing", () => {
        expect(readRunCard({ runId: 7 })).toEqual({ runId: "", title: "", stepCount: 0 });
    });
});
