/**
 * The DBOS run launcher roots a run in a trace of its own. The DBOS engine is
 * not launched: `DBOS.startWorkflow` is stubbed to record the OTel context it
 * was invoked under, which is the context the SDK parents the workflow span on.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { context, propagation, trace, type Context } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { Pool } from "pg";

import { ATTR_INFLEXA_RUN_ID, createDbosRunLauncher } from "../dbos-run-launcher.js";
import { presentFind } from "../../lib/present.js";

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;
let originalStartWorkflow: unknown;
let originalGetWorkflow: unknown;
let contextAtStart: Context | undefined;
let inputAtStart: unknown;

beforeEach(async () => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();

    const dbos = await import("@dbos-inc/dbos-sdk");
    originalStartWorkflow ??= dbos.DBOS.startWorkflow.bind(dbos.DBOS);
    contextAtStart = undefined;
    inputAtStart = undefined;
    Reflect.set(dbos.DBOS, "startWorkflow", () => (input: unknown) => {
        contextAtStart = context.active();
        inputAtStart = input;
        return Promise.resolve({});
    });
});

afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
});

afterAll(async () => {
    const dbos = await import("@dbos-inc/dbos-sdk");
    if (originalGetWorkflow !== undefined) Reflect.set(dbos.DBOSClient.prototype, "getWorkflow", originalGetWorkflow);
    if (originalStartWorkflow === undefined) return;
    Reflect.set(dbos.DBOS, "startWorkflow", originalStartWorkflow);
});

/** Make each start reject with `fault`, and make the read of a workflow give `read()`. */
async function failStart(fault: Error, read: () => Promise<unknown>): Promise<void> {
    const dbos = await import("@dbos-inc/dbos-sdk");
    originalGetWorkflow ??= Reflect.get(dbos.DBOSClient.prototype, "getWorkflow");
    Reflect.set(dbos.DBOS, "startWorkflow", () => () => Promise.reject(fault));
    Reflect.set(dbos.DBOSClient.prototype, "getWorkflow", read);
}

const workflow = (_input: { readonly planId: string }): Promise<unknown> => Promise.resolve(undefined);

describe("createDbosRunLauncher", () => {
    it("starts the workflow in a new trace, linked to the originating span", async () => {
        const launcher = createDbosRunLauncher({ pool: new Pool() });
        const tracer = trace.getTracer("test");
        const chat = tracer.startSpan("POST /chat");

        await context.with(trace.setSpan(context.active(), chat), () => launcher.launch(workflow, { workflowId: "run-1" }, { planId: "p" }));
        chat.end();

        expect(inputAtStart).toEqual({ planId: "p" });
        if (contextAtStart === undefined) throw new Error("the capture context is absent");
        const startedUnder = trace.getSpan(contextAtStart);
        if (startedUnder === undefined) throw new Error("the span at start is absent");
        expect(startedUnder.spanContext().traceId).not.toBe(chat.spanContext().traceId);

        const finished = exporter.getFinishedSpans();
        const root = presentFind(finished, (s) => s.name === "launch run");
        expect(root.spanContext().spanId).toBe(startedUnder.spanContext().spanId);
        expect(root.parentSpanContext).toBeUndefined();
        expect(root.attributes[ATTR_INFLEXA_RUN_ID]).toBe("run-1");
        expect(root.links.map((l) => l.context)).toEqual([chat.spanContext()]);

        const originating = presentFind(finished, (s) => s.name === "POST /chat");
        expect(originating.attributes[ATTR_INFLEXA_RUN_ID]).toBe("run-1");
    });

    it("starts the workflow in a new trace with no link when nothing is active", async () => {
        const launcher = createDbosRunLauncher({ pool: new Pool() });

        await launcher.launch(workflow, { workflowId: "run-2" }, { planId: "p" });

        const root = presentFind(exporter.getFinishedSpans(), (s) => s.name === "launch run");
        if (contextAtStart === undefined) throw new Error("the capture context is absent");
        const spanAtStart = trace.getSpan(contextAtStart);
        if (spanAtStart === undefined) throw new Error("the span at start is absent");
        expect(spanAtStart.spanContext().spanId).toBe(root.spanContext().spanId);
        expect(root.links).toEqual([]);
        expect(root.attributes[ATTR_INFLEXA_RUN_ID]).toBe("run-2");
    });

    it("ends the root span and rethrows when the start fails", async () => {
        await failStart(new Error("system database down"), () => Promise.resolve(undefined));
        const launcher = createDbosRunLauncher({ pool: new Pool() });

        await expect(launcher.launch(workflow, { workflowId: "run-3" }, { planId: "p" })).rejects.toThrow("system database down");
        expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["launch run"]);
    });

    it("resolves when the start fails and a workflow of the run id exists", async () => {
        // A first launch of a rerun can start the run, and then the second launch can fail for a transient
        // reason. The run is durably started, thus the launch is a success.
        await failStart(new Error("connection reset"), () => Promise.resolve({ workflowID: "run-4", status: "PENDING" }));
        const launcher = createDbosRunLauncher({ pool: new Pool() });

        await launcher.launch(workflow, { workflowId: "run-4" }, { planId: "p" });
    });

    it("rethrows the fault of the start when no workflow of the run id exists", async () => {
        await failStart(new Error("connection reset"), () => Promise.resolve(undefined));
        const launcher = createDbosRunLauncher({ pool: new Pool() });

        await expect(launcher.launch(workflow, { workflowId: "run-5" }, { planId: "p" })).rejects.toThrow("connection reset");
    });

    it("rethrows the fault of the start when the read of the workflow fails too", async () => {
        await failStart(new Error("connection reset"), () => Promise.reject(new Error("system database down")));
        const launcher = createDbosRunLauncher({ pool: new Pool() });

        await expect(launcher.launch(workflow, { workflowId: "run-6" }, { planId: "p" })).rejects.toThrow("connection reset");
    });
});
