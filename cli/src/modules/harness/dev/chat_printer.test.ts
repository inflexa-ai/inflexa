import { describe, expect, test } from "bun:test";
import { toChatFrame, type EmitFn, type EventSource, type PlanPart, type RunCardPart } from "@inflexa-ai/harness";

import type { ClientOpts } from "../../../client/api.ts";
import { fakeClient } from "../../../test_support/fake_client.ts";
import { createChatPrinter, type ChatSink, type PrinterOptions } from "./chat.ts";

/**
 * A recording sink + printer. `out()` accumulates conversation output; `errs`
 * accumulates diagnostics. `emit` takes the event that the agent loop emits, and
 * gives the printer the frame that the chat route of the server sends for it: the
 * route translates each event with `toChatFrame`, and the text delta of the root
 * provider gets the source of the root agent.
 */
function harness(options?: PrinterOptions): {
    emit: (e: Parameters<EmitFn>[0]) => void;
    emitCard: (e: Parameters<EmitFn>[0]) => Promise<void>;
    finishTurn: (t?: string) => void;
    out: () => string;
    errs: string[];
} {
    const outChunks: string[] = [];
    const errs: string[] = [];
    const sink: ChatSink = { out: (s) => outChunks.push(s), errLine: (s) => errs.push(s) };
    const printer = createChatPrinter(sink, options);
    // A frame that is not a card of openable entries prints before `frame` first waits, thus `emit` needs no wait.
    const emit = (e: Parameters<EmitFn>[0]): void => {
        const frame = toChatFrame(e, { agentId: "chat", callPath: ["chat"] });
        if (frame !== null) void printer.frame(frame);
    };
    const emitCard = async (e: Parameters<EmitFn>[0]): Promise<void> => {
        const frame = toChatFrame(e, { agentId: "chat", callPath: ["chat"] });
        if (frame !== null) await printer.frame(frame);
    };
    return { emit, emitCard, finishTurn: printer.finishTurn, out: () => outChunks.join(""), errs };
}

/** A server that resolves the one entry of a card to `path`. */
function serverResolving(kind: string, path: string): ClientOpts {
    return fakeClient(() => ({ status: 200, body: { entries: [{ kind, path, degraded: false }] } })).opts;
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

    test("sub-agent traffic outside any tool call is dropped — it has nothing to be subordinate to", () => {
        const h = harness();
        h.emit({ type: "tool-started", source: SUB, toolUseId: "t1", name: "grep", input: {} });
        h.emit({ type: "tool-finished", source: SUB, toolUseId: "t1", name: "grep", outcome: "ok" });
        h.emit({ type: "data-plan", source: SUB, data: { planId: "pln-deadbeef", title: "hidden", steps: [] } });
        expect(h.out()).toBe("");
        expect(h.errs).toEqual([]);
    });

    test("sub-agent traffic INSIDE a tool call renders as a subordinate line, never a transcript entry", () => {
        // Dropping it outright made a long tool call indistinguishable from a wedged one; emitting it
        // at the root would bury the conversation. Routed under its call, it is neither.
        const h = harness();
        h.emit({ type: "tool-started", source: TOP, toolUseId: "t1", name: "plan_analysis", input: {} });
        h.emit({ type: "tool-started", source: SUB, toolUseId: "s1", name: "search_papers", input: {} });
        const out = h.out();
        expect(out).toContain("[tool] plan_analysis running...");
        expect(out).toContain("planner: search_papers");
        // The sub-agent's own call did NOT open a transcript-level chip of its own.
        expect(out).not.toContain("[tool] search_papers");
    });

    test("a sub-agent data part still renders nothing — only activity is routed", () => {
        const h = harness();
        h.emit({ type: "tool-started", source: TOP, toolUseId: "t1", name: "plan_analysis", input: {} });
        h.emit({ type: "data-plan", source: SUB, data: { planId: "pln-deadbeef", title: "hidden", steps: [] } });
        // A sub-agent's plan card is content for its own caller, not activity — it must not surface.
        expect(h.out()).not.toContain("hidden");
        expect(h.out()).not.toContain("pln-deadbeef");
    });

    test("tool chip: one line on start, outcome on finish", () => {
        const h = harness();
        h.emit({ type: "tool-started", source: TOP, toolUseId: "t1", name: "grep", input: { q: "gene" } });
        h.emit({ type: "tool-finished", source: TOP, toolUseId: "t1", name: "grep", outcome: "ok" });
        const out = h.out();
        expect(out).toContain("[tool] grep running...");
        expect(out).toContain("[tool] grep done");
    });

    test("tool chip: error outcome is marked", () => {
        const h = harness();
        h.emit({ type: "tool-started", source: TOP, toolUseId: "t1", name: "read_file", input: {} });
        h.emit({ type: "tool-finished", source: TOP, toolUseId: "t1", name: "read_file", outcome: "error" });
        expect(h.out()).toContain("[tool] read_file error");
    });

    // A denial is the user's refusal, not a tool fault, so it gets its own word rather than `error`.
    test("tool chip: a denied outcome reads as denied, not as an error", () => {
        const h = harness();
        h.emit({ type: "tool-started", source: TOP, toolUseId: "t1", name: "execute_analysis", input: {} });
        h.emit({ type: "tool-finished", source: TOP, toolUseId: "t1", name: "execute_analysis", outcome: "denied" });
        const out = h.out();
        expect(out).toContain("[tool] execute_analysis denied");
        expect(out).not.toContain("execute_analysis error");
    });

    test("tool chip: a described call names what it is doing", () => {
        const h = harness();
        h.emit({ type: "tool-started", source: TOP, toolUseId: "t1", name: "run_inflexa", input: {}, detail: "refs list --json" });
        h.emit({ type: "tool-finished", source: TOP, toolUseId: "t1", name: "run_inflexa", outcome: "ok", detail: "refs list --json" });
        expect(h.out()).toContain("[tool] run_inflexa refs list --json running...");
    });

    test("tool chip: a tool with no hook prints the bare name, as before", () => {
        const h = harness();
        h.emit({ type: "tool-started", source: TOP, toolUseId: "t1", name: "search_gene", input: {} });
        expect(h.out()).toContain("[tool] search_gene running...");
    });

    test("data-plan renders id, title, and a branching dependency graph", () => {
        const h = harness();
        h.emit({
            type: "data-plan",
            source: TOP,
            data: {
                id: "pres-1",
                planId: "pln-abc12345",
                title: "Differential expression",
                steps: [
                    { id: "T1S1", name: "load", agent: "scientific-executor", question: "q", depends_on: [], maxSteps: 30 },
                    { id: "T2S1", name: "align", agent: "scientific-executor", question: "q", depends_on: ["T1S1"], maxSteps: 30 },
                    { id: "T3S1", name: "quantify", agent: "scientific-executor", question: "q", depends_on: ["T1S1"], maxSteps: 30 },
                ],
            },
        });
        const out = h.out();
        expect(out).toContain("[plan] Differential expression (pln-abc12345)");
        expect(out).toContain("T1S1 load");
        expect(out).toContain("T2S1 align");
        expect(out).toContain("T3S1 quantify");
        expect(out).toContain("┴");
        expect(out).not.toContain("- T1S1");
    });

    test("data-plan falls back to planId as heading when title is absent", () => {
        const h = harness();
        h.emit({ type: "data-plan", source: TOP, data: { id: "pres-1", planId: "pln-abc12345", steps: [] } });
        expect(h.out()).toContain("[plan] pln-abc12345 (pln-abc12345)");
    });

    test("an invalid part of a known type is dropped at receipt, and nothing prints", () => {
        const h = harness();
        // The status is outside the union of the ask part, thus the check refuses the part.
        h.emit({ type: "data-ask", source: TOP, data: { id: "ask-1", title: "t", command: "inflexa refs list", status: "granted" } });
        expect(h.out()).toBe("");
        expect(h.errs).toEqual([]);
    });

    test("data-run-card renders run id, title, and step count", () => {
        const h = harness();
        h.emit({ type: "data-run-card", source: TOP, data: { id: "pres-r", runId: "run-xyz", planId: "pln-abc12345", title: "DE run", stepCount: 3 } });
        expect(h.out()).toContain("[run] run-xyz: DE run (3 step(s))");
    });

    test("a text-shaped markdown presentation prints inline, not as a tag", () => {
        const h = harness();
        h.emit({ type: "data-presentation", source: TOP, data: { id: "x", title: "Finding", content: { kind: "markdown", body: "hi there" } } });
        expect(h.out()).toContain("hi there");
        expect(h.out()).not.toContain("[part:data-presentation]");
    });

    test("a text-shaped code presentation prints fenced", () => {
        const h = harness();
        h.emit({ type: "data-presentation", source: TOP, data: { id: "c", content: { kind: "code", code: "x <- 1", language: "r" } } });
        expect(h.out()).toContain("```r");
        expect(h.out()).toContain("x <- 1");
    });

    test("an openable entry links the path that the server resolves with `materialize`, not a path of this process", async () => {
        const server = fakeClient(() => ({
            status: 200,
            body: { entries: [{ kind: "echart", path: "/srv/ws/presentations/pres-chart.html", degraded: false }] },
        }));
        const h = harness({ analysisId: "a1", client: server.opts });
        await h.emitCard({
            type: "data-presentation",
            source: TOP,
            data: { id: "pres-chart", title: "Volcano", content: { kind: "echart", spec: { series: [] } } },
        });

        expect(server.requests).toEqual([
            {
                method: "POST",
                path: "/api/v1/analyses/a1/artifacts/resolve",
                body: { entries: [{ kind: "echart", presId: "pres-chart", spec: { series: [] } }], materialize: true },
            },
        ]);
        expect(h.out()).toContain("\x1b]8;;file:///srv/ws/presentations/pres-chart.html");
    });

    test("show_file openables print one line per entry with an OSC 8 file:// link and the plain path visible", async () => {
        const h = harness({ analysisId: "a1", client: serverResolving("workspace-file", "/ws/figures/volcano.png") });
        await h.emitCard({
            type: "data-file-reference",
            source: TOP,
            data: { id: "g", title: "Figures", files: [{ path: "runs/r/figures/volcano.png", caption: "A vs B" }] },
        });
        const out = h.out();
        expect(out).toContain("volcano.png"); // the entry name
        expect(out).toContain("/ws/figures/volcano.png"); // the plain path is visible
        expect(out).toContain("\x1b]8;;file:///ws/figures/volcano.png"); // wrapped in an OSC 8 hyperlink
        expect(out).toContain("A vs B"); // the caption
    });

    test("an echart presentation resolves through the server and links to the file that it wrote", async () => {
        const h = harness({ analysisId: "a1", client: serverResolving("echart", "/cache/pres-chart.html") });
        await h.emitCard({
            type: "data-presentation",
            source: TOP,
            data: { id: "pres-chart", title: "Volcano", content: { kind: "echart", spec: { series: [] } } },
        });
        const out = h.out();
        expect(out).toContain("Volcano");
        expect(out).toContain("/cache/pres-chart.html");
        expect(out).toContain("\x1b]8;;file:///cache/pres-chart.html");
    });

    test("a path with a space percent-encodes the file:// link target but keeps the plain path visible", async () => {
        const h = harness({ analysisId: "a1", client: serverResolving("workspace-file", "/ws/my figures/volcano plot.png") });
        await h.emitCard({
            type: "data-file-reference",
            source: TOP,
            data: { id: "g", title: "Figures", files: [{ path: "runs/r/figures/volcano plot.png" }] },
        });
        const out = h.out();
        // The visible text is the raw path (spaces intact) …
        expect(out).toContain("/ws/my figures/volcano plot.png");
        // … while the OSC 8 target is percent-encoded so the space cannot truncate the link.
        expect(out).toContain("\x1b]8;;file:///ws/my%20figures/volcano%20plot.png");
        expect(out).not.toContain("\x1b]8;;file:///ws/my figures/volcano plot.png");
    });

    test("data-ask prints a one-line approval mention naming the command and status, not the raw tag", () => {
        const h = harness();
        h.emit({ type: "data-ask", source: TOP, data: { id: "ask-1", title: "Run inflexa refs", command: "inflexa refs list", status: "pending" } });
        const out = h.out();
        expect(out).toContain("[approval] inflexa refs list — pending");
        expect(out).not.toContain("[part:data-ask]");
    });

    test("copy-on-receive: mutating a part after emit does not change output", () => {
        const h = harness();
        const data: Omit<PlanPart, "type"> & { title: string; steps: NonNullable<PlanPart["steps"]> } = {
            id: "pres-1",
            planId: "pln-abc12345",
            title: "Original",
            steps: [{ id: "S1", name: "one", agent: "a1", question: "q", depends_on: [], maxSteps: 30 }],
        };
        h.emit({ type: "data-plan", source: TOP, data });
        const snapshot = h.out();
        // Mutate the exact object handed to emit — the in-process emit hazard.
        data.title = "MUTATED";
        data.steps.push({ id: "S2", name: "two", agent: "a2", question: "q", depends_on: [], maxSteps: 30 });
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
        h.emit({ type: "tool-finished", source: TOP, toolUseId: "orphan", name: "grep", outcome: "ok" });
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
            h.emit({ type: "tool-finished", source: TOP, toolUseId: "fast", name: "grep", outcome: "ok" });
            clock = 2000;
            h.emit({ type: "tool-started", source: TOP, toolUseId: "slow", name: "align", input: {} });
            clock = 4500; // 2500ms elapsed → the `s` branch
            h.emit({ type: "tool-finished", source: TOP, toolUseId: "slow", name: "align", outcome: "ok" });
            const out = h.out();
            expect(out).toContain("[tool] grep done (300ms)");
            expect(out).toContain("[tool] align done (2.5s)");
        } finally {
            Date.now = realNow;
        }
    });

    test("copy-on-receive: mutating a run card after emit does not change output", () => {
        const h = harness();
        const data: Omit<RunCardPart, "type"> = { id: "pres-r", runId: "run-xyz", planId: "pln-abc12345", title: "Original", stepCount: 3 };
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
