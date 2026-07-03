import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { randomUUIDv7 } from "bun";
import { okAsync, errAsync } from "neverthrow";
import type { UpsertPlanInput } from "@inflexa-ai/harness";

import { intakePlan, type PlanIntakeDeps, type PlanIntakeError } from "./plan_intake.ts";

// A plan document, kept as a loose record so tests can craft malformed and
// structurally-invalid variants that never have to satisfy `AnalysisPlan`.
type PlanDoc = Record<string, unknown>;

/** A schema-valid, structurally-valid step assigned a REAL catalog agent id. */
function validStep(overrides: PlanDoc = {}): PlanDoc {
    return {
        id: "T1S1",
        name: "Quantify group differences",
        track: "T1",
        step_type: "analysis",
        question: "Which features differ between the groups?",
        acceptance_criteria: ["produces a ranked table of features"],
        depends_on: [],
        maxSteps: 10,
        resources: { cpu: 2, memoryGb: 4 },
        agent: "scientific-executor",
        ...overrides,
    };
}

/** A plan that passes `AnalysisPlanSchema` and `validatePlan`. */
function validPlan(overrides: PlanDoc = {}): PlanDoc {
    return {
        title: "Differential expression",
        analytical_narrative: "Explore the dataset and quantify differences between the groups.",
        created_at: "2026-07-03T00:00:00.000Z",
        steps: [validStep()],
        ...overrides,
    };
}

/** Independent re-derivation of the id contract, to pin the exact hash the module computes. */
function expectedId(analysisId: string, bytes: string): string {
    return `pln-${createHash("sha256")
        .update(analysisId + "\n")
        .update(bytes)
        .digest("hex")
        .slice(0, 8)}`;
}

/**
 * A seam that records every call and succeeds — models the harness's
 * insert-if-absent `upsertPlan`, whose repeat upsert is a success no-op. Tests
 * assert on `calls` to prove the seam is (or is NOT) reached.
 */
function recordingSeam(): { deps: PlanIntakeDeps; calls: UpsertPlanInput[] } {
    const calls: UpsertPlanInput[] = [];
    const deps: PlanIntakeDeps = {
        upsertPlan: (input) => {
            calls.push(input);
            return okAsync(undefined);
        },
    };
    return { deps, calls };
}

let dir: string;

beforeEach(() => {
    dir = join(tmpdir(), `plan-intake-test-${randomUUIDv7()}`);
    mkdirSync(dir, { recursive: true });
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** Write raw content and return its path. */
function writePlan(name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
}

/** Write a JSON document (dropping `undefined`-valued keys, as on-disk JSON would). */
function writePlanJson(name: string, doc: unknown): string {
    return writePlan(name, JSON.stringify(doc, null, 2));
}

/**
 * Take a plan in EXPECTING rejection: returns the error (extracted via `match`,
 * which is also what satisfies neverthrow's must-use-result rule) and fails loudly
 * if intake unexpectedly succeeded.
 */
async function intakeErr(analysisId: string, path: string, deps: PlanIntakeDeps): Promise<PlanIntakeError> {
    return (await intakePlan(analysisId, path, deps)).match(
        (out) => {
            throw new Error(`expected intake to reject but it succeeded with plan ${out.planId}`);
        },
        (err) => err,
    );
}

describe("intakePlan — valid plans", () => {
    test("persists once under the derived id and returns planId/plan/planSummary", async () => {
        const { deps, calls } = recordingSeam();
        const content = JSON.stringify(validPlan(), null, 2);
        const path = writePlan("plan.json", content);

        const out = (await intakePlan("analysis-1", path, deps))._unsafeUnwrap();

        expect(calls.length).toBe(1);
        const call = calls[0];
        if (!call) throw new Error("expected the persistence seam to be called exactly once");
        expect(call.planId).toBe(out.planId);
        expect(call.analysisId).toBe("analysis-1");
        // The seam receives the PARSED plan, not the raw bytes.
        expect((call.plan as { analytical_narrative: string }).analytical_narrative).toBe("Explore the dataset and quantify differences between the groups.");
        expect(out.planId).toBe(expectedId("analysis-1", content));
        expect(out.planId).toMatch(/^pln-[a-f0-9]{8}$/);
        expect(out.plan.steps[0]?.agent).toBe("scientific-executor");
        expect(out.planSummary).toBe("Differential expression");
    });

    test("planSummary falls back to the narrative slice (first 280 chars) when title is absent", async () => {
        const { deps } = recordingSeam();
        const narrative = "N".repeat(400);
        // `title: undefined` → JSON.stringify omits the key → schema parses title as absent.
        const path = writePlanJson("plan.json", validPlan({ title: undefined, analytical_narrative: narrative }));

        const out = (await intakePlan("a1", path, deps))._unsafeUnwrap();

        expect(out.planSummary).toBe(narrative.slice(0, 280));
        expect(out.planSummary.length).toBe(280);
    });

    test("repeat intake of the same file reports success both times with one stable id", async () => {
        const { deps, calls } = recordingSeam();
        const path = writePlanJson("plan.json", validPlan());

        const first = await intakePlan("a1", path, deps);
        const second = await intakePlan("a1", path, deps);

        expect(first.isOk()).toBe(true);
        expect(second.isOk()).toBe(true);
        expect(first._unsafeUnwrap().planId).toBe(second._unsafeUnwrap().planId);
        // Seam invoked both times; the real store no-ops on the second (ON CONFLICT DO NOTHING).
        expect(calls.length).toBe(2);
    });
});

describe("intakePlan — deterministic plan id", () => {
    test("same analysis + same bytes → identical id across invocations, matching the contract", async () => {
        const { deps } = recordingSeam();
        const path = writePlanJson("plan.json", validPlan());

        const a = (await intakePlan("a1", path, deps))._unsafeUnwrap();
        const b = (await intakePlan("a1", path, deps))._unsafeUnwrap();

        expect(a.planId).toBe(b.planId);
        expect(a.planId).toMatch(/^pln-[a-f0-9]{8}$/);
    });

    test("different bytes → different id (an edited plan is a new plan)", async () => {
        const { deps } = recordingSeam();
        const p1 = writePlanJson("p1.json", validPlan({ analytical_narrative: "one" }));
        const p2 = writePlanJson("p2.json", validPlan({ analytical_narrative: "two" }));

        const a = (await intakePlan("a1", p1, deps))._unsafeUnwrap();
        const b = (await intakePlan("a1", p2, deps))._unsafeUnwrap();

        expect(a.planId).not.toBe(b.planId);
    });

    test("different analysis + same bytes → different id (no cross-analysis collision)", async () => {
        const { deps } = recordingSeam();
        const path = writePlanJson("plan.json", validPlan());

        const a = (await intakePlan("a1", path, deps))._unsafeUnwrap();
        const b = (await intakePlan("a2", path, deps))._unsafeUnwrap();

        expect(a.planId).not.toBe(b.planId);
    });
});

describe("intakePlan — rejections persist nothing", () => {
    test("unreadable path → read_failed, seam never called", async () => {
        const { deps, calls } = recordingSeam();

        const e = await intakeErr("a1", join(dir, "does-not-exist.json"), deps);

        expect(e.type).toBe("read_failed");
        expect(e.path).toContain("does-not-exist.json");
        expect(calls.length).toBe(0);
    });

    test("invalid JSON → invalid_json, seam never called", async () => {
        const { deps, calls } = recordingSeam();
        const path = writePlan("bad.json", "{ not: valid json");

        const e = await intakeErr("a1", path, deps);

        expect(e.type).toBe("invalid_json");
        expect(calls.length).toBe(0);
    });

    test("schema-invalid document → schema_invalid with verbatim zod issues, seam never called", async () => {
        const { deps, calls } = recordingSeam();
        // Missing `analytical_narrative` (required by AnalysisPlanSchema).
        const path = writePlanJson("plan.json", { title: "x", steps: [], created_at: "t" });

        const e = await intakeErr("a1", path, deps);

        expect(e.type).toBe("schema_invalid");
        if (e.type === "schema_invalid") {
            expect(e.issues.length).toBeGreaterThan(0);
            expect(e.issues.some((i) => i.path.includes("analytical_narrative"))).toBe(true);
        }
        expect(calls.length).toBe(0);
    });

    test("dependency cycle → plan_invalid surfacing validatePlan's cycle error, seam never called", async () => {
        const { deps, calls } = recordingSeam();
        const doc = validPlan({
            steps: [validStep({ id: "T1S1", depends_on: ["T1S2"] }), validStep({ id: "T1S2", depends_on: ["T1S1"] })],
        });

        const e = await intakeErr("a1", writePlanJson("plan.json", doc), deps);

        expect(e.type).toBe("plan_invalid");
        if (e.type === "plan_invalid") {
            expect(e.errors.some((m) => m.includes("Dependency cycle detected"))).toBe(true);
        }
        expect(calls.length).toBe(0);
    });

    test("unknown agent id → plan_invalid with the verbatim catalog error, seam never called", async () => {
        const { deps, calls } = recordingSeam();
        const doc = validPlan({ steps: [validStep({ agent: "no-such-agent" })] });

        const e = await intakeErr("a1", writePlanJson("plan.json", doc), deps);

        expect(e.type).toBe("plan_invalid");
        if (e.type === "plan_invalid") {
            expect(e.errors).toContain('Step "T1S1" assigns unknown agent "no-such-agent" — not found in agent catalog');
        }
        expect(calls.length).toBe(0);
    });

    test("step without resources → plan_invalid with the verbatim error, seam never called", async () => {
        const { deps, calls } = recordingSeam();
        const doc = validPlan({ steps: [validStep({ resources: undefined })] });

        const e = await intakeErr("a1", writePlanJson("plan.json", doc), deps);

        expect(e.type).toBe("plan_invalid");
        if (e.type === "plan_invalid") {
            expect(e.errors).toContain('Step "T1S1" has no resources defined — cpu and memoryGb are required');
        }
        expect(calls.length).toBe(0);
    });
});

describe("intakePlan — persistence failure", () => {
    test("seam error surfaces as persist_failed carrying the underlying cause", async () => {
        const dbErr = { type: "mutation_failed", op: "plans.upsertPlan", cause: new Error("db down") } as const;
        const deps: PlanIntakeDeps = { upsertPlan: () => errAsync(dbErr) };
        const path = writePlanJson("plan.json", validPlan());

        const e = await intakeErr("a1", path, deps);

        expect(e.type).toBe("persist_failed");
        if (e.type === "persist_failed") expect(e.cause).toBe(dbErr);
    });
});
