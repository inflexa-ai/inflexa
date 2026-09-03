/**
 * The DBOS run launcher roots a run in a trace of its own. The DBOS engine is
 * not launched: `DBOS.startWorkflow` is stubbed to record the OTel context it
 * was invoked under, which is the context the SDK parents the workflow span on.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { context, propagation, trace, type Context } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import { ATTR_INFLEXA_RUN_ID, createDbosRunLauncher } from "./dbos-run-launcher.js";

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;
let originalStartWorkflow: unknown;
let contextAtStart: Context | undefined;
let inputAtStart: unknown;

beforeEach(async () => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();

    const dbos = await import("@dbos-inc/dbos-sdk");
    originalStartWorkflow ??= dbos.DBOS.startWorkflow;
    contextAtStart = undefined;
    inputAtStart = undefined;
    (dbos.DBOS.startWorkflow as unknown) = () => async (input: unknown) => {
        contextAtStart = context.active();
        inputAtStart = input;
        return {};
    };
});

afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
});

afterAll(async () => {
    if (originalStartWorkflow === undefined) return;
    const dbos = await import("@dbos-inc/dbos-sdk");
    (dbos.DBOS.startWorkflow as unknown) = originalStartWorkflow;
});

const workflow = async (_input: { readonly planId: string }): Promise<unknown> => undefined;

describe("createDbosRunLauncher", () => {
    it("starts the workflow in a new trace, linked to the originating span", async () => {
        const launcher = createDbosRunLauncher();
        const tracer = trace.getTracer("test");
        const chat = tracer.startSpan("POST /chat");

        await context.with(trace.setSpan(context.active(), chat), () => launcher.launch(workflow, { workflowId: "run-1" }, { planId: "p" }));
        chat.end();

        expect(inputAtStart).toEqual({ planId: "p" });
        const startedUnder = trace.getSpan(contextAtStart!)!.spanContext();
        expect(startedUnder.traceId).not.toBe(chat.spanContext().traceId);

        const finished = exporter.getFinishedSpans();
        const root = finished.find((s) => s.name === "launch run")!;
        expect(root.spanContext().spanId).toBe(startedUnder.spanId);
        expect(root.parentSpanContext).toBeUndefined();
        expect(root.attributes[ATTR_INFLEXA_RUN_ID]).toBe("run-1");
        expect(root.links.map((l) => l.context)).toEqual([chat.spanContext()]);

        const originating = finished.find((s) => s.name === "POST /chat")!;
        expect(originating.attributes[ATTR_INFLEXA_RUN_ID]).toBe("run-1");
    });

    it("starts the workflow in a new trace with no link when nothing is active", async () => {
        const launcher = createDbosRunLauncher();

        await launcher.launch(workflow, { workflowId: "run-2" }, { planId: "p" });

        const root = exporter.getFinishedSpans().find((s) => s.name === "launch run")!;
        expect(trace.getSpan(contextAtStart!)!.spanContext().spanId).toBe(root.spanContext().spanId);
        expect(root.links).toEqual([]);
        expect(root.attributes[ATTR_INFLEXA_RUN_ID]).toBe("run-2");
    });

    it("ends the root span and rethrows when the start fails", async () => {
        const dbos = await import("@dbos-inc/dbos-sdk");
        (dbos.DBOS.startWorkflow as unknown) = () => async () => {
            throw new Error("system database down");
        };
        const launcher = createDbosRunLauncher();

        await expect(launcher.launch(workflow, { workflowId: "run-3" }, { planId: "p" })).rejects.toThrow("system database down");
        expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["launch run"]);
    });
});
