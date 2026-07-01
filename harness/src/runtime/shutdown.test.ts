import { describe, expect, it } from "bun:test";
import pino from "pino";

import { runShutdownSequence } from "./shutdown.js";

const silentLogger = pino({ level: "silent" });

function makeRecordedDeps(
    overrides: Partial<{
        closeHttpServer: () => Promise<void>;
        shutdownDbos: () => Promise<void>;
        closePool: () => Promise<void>;
    }> = {},
) {
    const calls: string[] = [];
    let drainingAt: number | undefined;
    let exitedWith: number | undefined;
    const record = (name: string, fn?: () => Promise<void>) => async () => {
        calls.push(name);
        if (fn) await fn();
    };
    return {
        calls,
        get drainingAt() {
            return drainingAt;
        },
        get exitedWith() {
            return exitedWith;
        },
        deps: {
            signal: "SIGTERM",
            logger: silentLogger,
            markDraining: () => {
                drainingAt = calls.length;
                calls.push("draining");
            },
            closeHttpServer: record("http-drain", overrides.closeHttpServer),
            shutdownDbos: record("dbos-shutdown", overrides.shutdownDbos),
            closePool: record("pool-close", overrides.closePool),
            flushLogger: record("logger-flush"),
            shutdownOtel: record("otel-flush"),
            exit: (code: number) => {
                exitedWith = code;
                calls.push("exit");
            },
        },
    };
}

describe("runShutdownSequence", () => {
    it("runs steps in the documented order", async () => {
        const r = makeRecordedDeps();
        await runShutdownSequence(r.deps);

        expect(r.calls).toEqual(["draining", "http-drain", "dbos-shutdown", "pool-close", "otel-flush", "logger-flush", "exit"]);
        expect(r.drainingAt).toBe(0);
        expect(r.exitedWith).toBe(0);
    });

    it("DBOS shutdown runs after HTTP drains and before pool closes", async () => {
        const r = makeRecordedDeps();
        await runShutdownSequence(r.deps);
        const httpIdx = r.calls.indexOf("http-drain");
        const dbosIdx = r.calls.indexOf("dbos-shutdown");
        const poolIdx = r.calls.indexOf("pool-close");
        expect(httpIdx).toBeLessThan(dbosIdx);
        expect(dbosIdx).toBeLessThan(poolIdx);
    });

    it("continues to exit even if one step fails", async () => {
        const r = makeRecordedDeps({
            shutdownDbos: async () => {
                throw new Error("dbos-boom");
            },
        });
        await runShutdownSequence(r.deps);
        expect(r.exitedWith).toBe(0);
        expect(r.calls).toContain("pool-close");
        expect(r.calls).toContain("exit");
    });

    it("draining is the first effect — happens before any I/O", async () => {
        const r = makeRecordedDeps();
        await runShutdownSequence(r.deps);
        expect(r.calls[0]).toBe("draining");
    });
});
