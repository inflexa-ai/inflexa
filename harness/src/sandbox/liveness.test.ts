/**
 * Unit tests for the transport-agnostic liveness escalation policy, the
 * never-throwing probe runner, and the shared synthetic-failure constructor
 * (the harness-sandbox-exec spec, "sustained unavailability escalates to a
 * liveness probe"). Pure logic — no DBOS, no network.
 */

import { describe, expect, test } from "bun:test";
import { createEscalationPolicy, PROBE_AFTER_UNAVAILABLE_POLLS, probeLiveness, syntheticFailureReason, syntheticFailureResult } from "./liveness.js";
import { ExecResultSchema, type SandboxRef } from "./types.js";

const REF: SandboxRef = {
    sandboxId: "sb-1",
    host: "127.0.0.1",
    port: 8765,
    backend: "docker",
    callbackSecret: "unused",
};

describe("createEscalationPolicy", () => {
    test("arms exactly on the threshold-th consecutive unavailable poll", () => {
        const policy = createEscalationPolicy(3);
        expect(policy.onPoll("unavailable")).toBe(false);
        expect(policy.onPoll("unavailable")).toBe(false);
        expect(policy.onPoll("unavailable")).toBe(true);
    });

    test("an ok poll resets the streak", () => {
        const policy = createEscalationPolicy(3);
        policy.onPoll("unavailable");
        policy.onPoll("unavailable");
        expect(policy.onPoll("ok")).toBe(false);
        expect(policy.onPoll("unavailable")).toBe(false);
        expect(policy.onPoll("unavailable")).toBe(false);
        expect(policy.onPoll("unavailable")).toBe(true);
    });

    test("re-arms from zero after firing", () => {
        const policy = createEscalationPolicy(2);
        policy.onPoll("unavailable");
        expect(policy.onPoll("unavailable")).toBe(true);
        expect(policy.onPoll("unavailable")).toBe(false);
        expect(policy.onPoll("unavailable")).toBe(true);
    });

    test("defaults to the module threshold", () => {
        const policy = createEscalationPolicy();
        for (let i = 1; i < PROBE_AFTER_UNAVAILABLE_POLLS; i++) {
            expect(policy.onPoll("unavailable")).toBe(false);
        }
        expect(policy.onPoll("unavailable")).toBe(true);
    });
});

describe("probeLiveness", () => {
    test("alive machine maps to an alive verdict", async () => {
        const verdict = await probeLiveness(async () => ({ alive: true, oomKilled: false }), REF);
        expect(verdict).toEqual({ kind: "alive" });
    });

    test("dead machine maps to dead and carries the OOM attribution", async () => {
        const dead = await probeLiveness(async () => ({ alive: false, oomKilled: false }), REF);
        expect(dead).toEqual({ kind: "dead", oomKilled: false });

        const oom = await probeLiveness(async () => ({ alive: false, oomKilled: true }), REF);
        expect(oom).toEqual({ kind: "dead", oomKilled: true });
    });

    test("a thrown inspect is inconclusive, never a throw", async () => {
        const verdict = await probeLiveness(async () => {
            throw new Error("docker daemon unreachable");
        }, REF);
        expect(verdict.kind).toBe("inconclusive");
        if (verdict.kind === "inconclusive") {
            expect(verdict.detail).toContain("docker daemon unreachable");
        }
    });
});

describe("syntheticFailureReason", () => {
    test("OOM-killed machines get the distinguishable reason", () => {
        expect(syntheticFailureReason({ oomKilled: true })).toBe("sandbox-oom-killed");
        expect(syntheticFailureReason({ oomKilled: false })).toBe("sandbox-dead");
    });
});

describe("syntheticFailureResult", () => {
    test("builds the watchdog-shaped ExecResult and parses under the schema", () => {
        const result = syntheticFailureResult("wf-1:step-a:fn-0", "sandbox-oom-killed");
        expect(result).toEqual({
            execId: "wf-1:step-a:fn-0",
            exitCode: null,
            stdout: "",
            stderr: "",
            durationMs: null,
            timedOut: false,
            syntheticFailure: { reason: "sandbox-oom-killed" },
        });
        expect(ExecResultSchema.parse(result)).toEqual(result);
    });
});
