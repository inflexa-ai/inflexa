import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createConsoleLogger, createNoopLogger } from "./console-logger.js";
import type { Logger } from "./logger.js";

/**
 * The emitted record IS this module's observable output, so the console methods
 * are captured rather than spied for call counts — the assertions below are on
 * what a sink receives, not on how it was reached.
 */
type Captured = { level: string; msg: string; fields: Record<string, unknown> };

describe("createConsoleLogger", () => {
    let captured: Captured[];
    const real = { debug: console.debug, info: console.info, warn: console.warn, error: console.error };

    beforeEach(() => {
        captured = [];
        for (const level of ["debug", "info", "warn", "error"] as const) {
            console[level] = (msg: string, fields: Record<string, unknown>): void => {
                captured.push({ level, msg, fields });
            };
        }
    });

    afterEach(() => {
        Object.assign(console, real);
    });

    it("writes each level to the matching console method", () => {
        const log = createConsoleLogger();
        log.debug("d");
        log.info("i");
        log.warn("w");
        log.error("e");

        expect(captured.map((c) => c.level)).toEqual(["debug", "info", "warn", "error"]);
        expect(captured.map((c) => c.msg)).toEqual(["d", "i", "w", "e"]);
    });

    it("carries call-site fields onto the record", () => {
        createConsoleLogger().error("[sandbox-step] failure", { runId: "r1", stepId: "T3S1" });

        expect(captured[0]).toMatchObject({
            level: "error",
            msg: "[sandbox-step] failure",
            fields: { runId: "r1", stepId: "T3S1" },
        });
    });

    it("merges with() bindings into every record", () => {
        const log = createConsoleLogger().with({ runId: "r1", stepId: "T3S1" });
        log.warn("teardown failed", { err: "boom" });

        expect(captured[0]!.fields).toEqual({ runId: "r1", stepId: "T3S1", err: "boom" });
    });

    it("composes later with() calls onto earlier bindings", () => {
        const log = createConsoleLogger().with({ runId: "r1" }).with({ stepId: "T3S1" });
        log.info("registering artifacts");

        expect(captured[0]!.fields).toEqual({ runId: "r1", stepId: "T3S1" });
    });

    it("lets a call-site field win over an inherited binding", () => {
        createConsoleLogger().with({ stepId: "T3S1" }).info("override", { stepId: "T3S2" });

        expect(captured[0]!.fields).toEqual({ stepId: "T3S2" });
    });

    it("leaves the parent logger's bindings untouched when deriving a child", () => {
        const parent = createConsoleLogger().with({ runId: "r1" });
        parent.with({ stepId: "T3S1" });
        parent.info("parent still bare");

        expect(captured[0]!.fields).toEqual({ runId: "r1" });
    });

    it("renders named() as a bracketed message prefix", () => {
        createConsoleLogger().named("boot").info("harness booted");

        expect(captured[0]!.msg).toBe("[boot] harness booted");
    });

    it("composes nested named() segments with a dot", () => {
        createConsoleLogger().named("post-step").named("reconcile").warn("dropping phantom");

        expect(captured[0]!.msg).toBe("[post-step.reconcile] dropping phantom");
    });

    it("leaves the message untouched with no namespace bound", () => {
        createConsoleLogger().info("bare");

        expect(captured[0]!.msg).toBe("bare");
    });

    it("keeps namespace and fields independent across with()/named()", () => {
        createConsoleLogger().named("sandbox-step").with({ runId: "r1" }).named("post-step").error("boom", { err: "x" });

        expect(captured[0]).toMatchObject({
            msg: "[sandbox-step.post-step] boom",
            fields: { runId: "r1", err: "x" },
        });
    });
});

describe("errorFields", () => {
    it("maps an Error to message + stack fields", () => {
        const log = createConsoleLogger();
        const fields = log.errorFields(new Error("boom"));

        expect(fields.err).toBe("boom");
        expect(fields.stack).toContain("boom");
    });

    it("stringifies a non-Error throw", () => {
        expect(createConsoleLogger().errorFields("plain string")).toEqual({ err: "plain string" });
        expect(createConsoleLogger().errorFields(42)).toEqual({ err: "42" });
    });

    it("survives the round trip a JSON sink would apply", () => {
        // The reason a raw Error is never passed through as a field value:
        // JSON.stringify(new Error("boom")) is "{}" — the message would vanish.
        const fields = createConsoleLogger().errorFields(new Error("boom"));

        expect(JSON.parse(JSON.stringify(fields)).err).toBe("boom");
        expect(JSON.parse(JSON.stringify({ err: new Error("boom") })).err).toEqual({});
    });

    it("is a realization's to override — the reason it sits on the interface", () => {
        // A pino- or OTel-backed realization defers to its sink's native error
        // handling (pino's `err` serializer, the `exception.*` semconv) instead of
        // the shipped mapping. Overriding must reach the harness's call sites.
        const base = createConsoleLogger();
        const custom: Logger = { ...base, errorFields: (err) => ({ "exception.message": String(err) }) };

        expect(custom.errorFields(new Error("boom"))).toEqual({ "exception.message": "Error: boom" });
    });
});

describe("createNoopLogger", () => {
    it("discards every record and survives with()/named() chaining", () => {
        const seen: string[] = [];
        const real = console.error;
        console.error = (msg: string): void => void seen.push(msg);
        try {
            const log = createNoopLogger().named("boot").with({ runId: "r1" });
            log.error("should not surface", { err: "x" });
            log.info("nor this");
        } finally {
            console.error = real;
        }

        expect(seen).toEqual([]);
    });
});
