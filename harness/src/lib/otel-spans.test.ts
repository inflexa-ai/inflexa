/**
 * The span policy is exercised the way `initOtel` composes it: the sampler on
 * a tracer provider, and the processor in front of the exporting processor.
 * An in-memory exporter stands in for the OTLP one, so the tests assert on
 * exactly what would leave the process. The provider is registered so that
 * `context.with` carries a span the way DBOS's `runWithTrace` does.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { context, propagation, ROOT_CONTEXT, trace, TraceFlags, type Span as ApiSpan } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";

import {
    ATTR_INFLEXA_EXEC_ID,
    ATTR_INFLEXA_STEP_ID,
    createHarnessSampler,
    DbosSpanProcessor,
    HarnessTracerProvider,
    stableSpan,
    untracedFetch,
    untracedWorkflow,
} from "./otel-spans.js";

let exporter: InMemorySpanExporter;
let provider: HarnessTracerProvider;
let untracedCounter = 0;

beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new HarnessTracerProvider({
        sampler: createHarnessSampler(),
        spanProcessors: [new DbosSpanProcessor(new SimpleSpanProcessor(exporter))],
    });
    provider.register();
});

afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
});

function tracer() {
    return provider.getTracer("otel-spans-test");
}

/** A fresh untraced name for each test, because the set outlives a test. */
function freshUntraced(): string {
    const name = `test-untraced-${++untracedCounter}`;
    untracedWorkflow(name);
    return name;
}

function childOf(parent: ApiSpan, name: string): ApiSpan {
    return tracer().startSpan(name, {}, trace.setSpan(context.active(), parent));
}

/** Run `fn` under `span`, the way DBOS runs a step body under its step span. */
function under<T>(span: ApiSpan, fn: () => T): T {
    return context.with(trace.setSpan(context.active(), span), fn);
}

function exportedNames(): string[] {
    return exporter.getFinishedSpans().map((s) => s.name);
}

function exportedByName(name: string): ReadableSpan {
    const found = exporter.getFinishedSpans().find((s) => s.name === name);
    if (found === undefined) throw new Error(`no exported span named ${name}`);
    return found;
}

describe("createHarnessSampler", () => {
    it("records nothing for an untraced workflow and its children", () => {
        const name = freshUntraced();
        const root = tracer().startSpan(name);
        const step = childOf(root, "query-active-sandboxes");
        const query = childOf(step, "pg.query");
        expect(root.isRecording()).toBe(false);
        expect(step.isRecording()).toBe(false);
        expect(query.isRecording()).toBe(false);
        query.end();
        step.end();
        root.end();
        expect(exportedNames()).toEqual([]);
    });

    it("records every other root and its children", () => {
        const root = tracer().startSpan("executeAnalysis");
        const step = childOf(root, "generate-file-metadata");
        step.end();
        root.end();
        expect(exportedNames()).toEqual(["generate-file-metadata", "executeAnalysis"]);
    });

    it("honours a name declared after the provider was created, from the next root span on", () => {
        const name = `test-late-untraced-${++untracedCounter}`;
        const before = tracer().startSpan(name);
        expect(before.isRecording()).toBe(true);
        before.end();

        untracedWorkflow(name);
        const after = tracer().startSpan(name);
        expect(after.isRecording()).toBe(false);
        after.end();

        expect(exportedNames()).toEqual([name]);
    });

    it("takes the decision of a remote parent, so an untraced name under a sampled remote parent is recorded", () => {
        const name = freshUntraced();
        const remote = trace.setSpanContext(ROOT_CONTEXT, {
            traceId: "0af7651916cd43dd8448eb211c80319c",
            spanId: "b7ad6b7169203331",
            traceFlags: TraceFlags.SAMPLED,
            isRemote: true,
        });
        const span = tracer().startSpan(name, {}, remote);
        expect(span.isRecording()).toBe(true);
        span.end();
        expect(exportedNames()).toEqual([name]);
    });
});

describe("DbosSpanProcessor", () => {
    it("drops a span that is marked cached after it started, and keeps its siblings", () => {
        const root = tracer().startSpan("executeAnalysis");
        const replayed = childOf(root, "generate-file-metadata");
        const fresh = childOf(root, "generate-step-summary");
        replayed.setAttribute("cached", true);
        replayed.end();
        fresh.end();
        root.end();
        expect(exportedNames()).toEqual(["generate-step-summary", "executeAnalysis"]);
    });

    it("keeps a span whose cached attribute is not the boolean true", () => {
        const span = tracer().startSpan("a-step");
        span.setAttribute("cached", "true");
        span.end();
        expect(exportedNames()).toEqual(["a-step"]);
    });
});

describe("stableSpan", () => {
    it("renames the active span that carries the DBOS name and attributes the id", () => {
        const step = tracer().startSpan("compose-step-seed:qc-filter");
        under(step, () => stableSpan("compose-step-seed:qc-filter", "compose-step-seed", { [ATTR_INFLEXA_STEP_ID]: "qc-filter" }));
        step.end();
        expect(exportedNames()).toEqual(["compose-step-seed"]);
        expect(exportedByName("compose-step-seed").attributes).toMatchObject({ [ATTR_INFLEXA_STEP_ID]: "qc-filter" });
    });

    it("is a no-op with no active span", () => {
        expect(() => stableSpan("sandbox.exec", "sandbox.exec", { [ATTR_INFLEXA_EXEC_ID]: "wf-1:7" })).not.toThrow();
        expect(exportedNames()).toEqual([]);
    });

    it("is a no-op on a non-recording span", () => {
        const name = freshUntraced();
        const root = tracer().startSpan(name);
        const step = childOf(root, "compose-step-seed:qc-filter");
        expect(step.isRecording()).toBe(false);
        expect(() => under(step, () => stableSpan("compose-step-seed:qc-filter", "compose-step-seed", { [ATTR_INFLEXA_STEP_ID]: "qc-filter" }))).not.toThrow();
        step.end();
        root.end();
        expect(exportedNames()).toEqual([]);
    });

    it("leaves an active span alone when its name is not the DBOS name", () => {
        const request = tracer().startSpan("POST /chat");
        under(request, () => stableSpan("sandbox.exec", "sandbox.exec", { [ATTR_INFLEXA_EXEC_ID]: "wf-1:7" }));
        request.end();
        expect(exportedNames()).toEqual(["POST /chat"]);
        expect(exportedByName("POST /chat").attributes).not.toHaveProperty(ATTR_INFLEXA_EXEC_ID);
    });
});

describe("untracedFetch", () => {
    it("sends the active span's traceparent to sandbox-server and runs the fetch with tracing suppressed", async () => {
        let sent: { headers: Record<string, string>; suppressed: boolean } | undefined;
        const accepted = (async (_url: string, init: RequestInit & { headers: Record<string, string> }) => {
            sent = { headers: init.headers, suppressed: isTracingSuppressed(context.active()) };
            return new Response("{}", { status: 202 });
        }) as unknown as typeof fetch;

        const step = tracer().startSpan("sandbox.exec");
        await under(step, () => untracedFetch(accepted, "http://127.0.0.1:8765/exec", { method: "POST", headers: {} }));
        step.end();

        const exported = exportedByName("sandbox.exec");
        expect(sent?.headers.traceparent).toBe(`00-${exported.spanContext().traceId}-${exported.spanContext().spanId}-01`);
        expect(sent?.suppressed).toBe(true);
        expect(exportedNames()).toEqual(["sandbox.exec"]);
    });
});
