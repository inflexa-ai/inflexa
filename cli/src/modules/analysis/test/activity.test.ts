import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { insertAnalysis, insertAnchor } from "../../../db/primary_mutation.ts";
import { listAnalysisPage } from "../../../db/primary_query.ts";
import { Bus } from "../../../lib/bus.ts";
import { asStr256 } from "../../../lib/types.ts";
import { freshDb } from "../../../test_support/db.ts";
import type { BusEvent } from "../../../types/events.ts";
import type { ProvActor, ProvInputRef } from "../../../types/prov.ts";
import { noteAnalysisActivity, notifyProfileSettledActivity, watchAnalysisActivity } from "../activity.ts";
import { present } from "../../../lib/present.ts";

const ANALYSIS = "analysis-1";
const CREATED = 1_000;

/** The activity time of the analysis, as the list page reads it. */
function activityAt(): number {
    return present(
        listAnalysisPage({ projectId: null, sort: "created", limit: 10, offset: 0 })
            ._unsafeUnwrap()
            .items.find((item) => item.analysis.id === ANALYSIS),
    ).lastActivityAt;
}

const ACTOR: ProvActor = { kind: "system", label: "inflexa cli", version: "0.0.0" };

/** The run-start event of `runId` at `startedAtMs`, for `analysisId`. */
function runStarted(startedAtMs: number, analysisId: string = ANALYSIS): BusEvent {
    return { type: "prov.run_started", analysisId, actor: ACTOR, run: { runId: "r1", planSummary: "p", startedAtMs } };
}

/** The run-end event of run `r1`. */
function runCompleted(completedAtMs: number, durationMs: number): BusEvent {
    return { type: "prov.run_completed", analysisId: ANALYSIS, actor: ACTOR, outcome: { runId: "r1", status: "completed", completedAtMs, durationMs } };
}

const INPUT: ProvInputRef = { path: "a.csv", isDir: false, anchorId: null };

let stop: (() => void) | null = null;

beforeEach(() => {
    freshDb();
    insertAnchor({ id: "anchor-1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/a", markerWritten: false, lastSeen: 1 })._unsafeUnwrap();
    insertAnalysis({
        id: ANALYSIS,
        createdAt: CREATED,
        updatedAt: CREATED,
        name: asStr256("a"),
        slug: "a",
        anchorId: "anchor-1",
        projectId: null,
    })._unsafeUnwrap();
});

afterEach(() => {
    stop?.();
    stop = null;
});

describe("watchAnalysisActivity", () => {
    test("a run start takes the start time of the run", () => {
        stop = watchAnalysisActivity();
        Bus.emit("inflexa", runStarted(5_000));
        expect(activityAt()).toBe(5_000);
    });

    test("a run end takes the completion time of the outcome", () => {
        stop = watchAnalysisActivity();
        Bus.emit("inflexa", runCompleted(8_000, 3_000));
        expect(activityAt()).toBe(8_000);
    });

    test("an input add takes the time of its delivery", () => {
        stop = watchAnalysisActivity();
        const before = Date.now();
        Bus.emit("inflexa", { type: "prov.input_added", analysisId: ANALYSIS, actor: ACTOR, input: INPUT, derivedFromAnalysisId: null });
        expect(activityAt()).toBeGreaterThanOrEqual(before);
    });

    test("an input removal takes the time of its delivery", () => {
        stop = watchAnalysisActivity();
        const before = Date.now();
        Bus.emit("inflexa", { type: "prov.input_removed", analysisId: ANALYSIS, actor: ACTOR, input: INPUT });
        expect(activityAt()).toBeGreaterThanOrEqual(before);
    });

    test("a run event that fires again with the same time changes nothing", () => {
        stop = watchAnalysisActivity();
        const completed = runCompleted(8_000, 1);
        Bus.emit("inflexa", completed);
        Bus.emit("inflexa", completed);
        expect(activityAt()).toBe(8_000);
    });

    test("an event with a time before the stored time does not lower it", () => {
        stop = watchAnalysisActivity();
        noteAnalysisActivity(ANALYSIS, 9_000);
        Bus.emit("inflexa", runStarted(2_000));
        expect(activityAt()).toBe(9_000);
    });

    test("an event of another family, and an event of an unknown analysis, change nothing", () => {
        stop = watchAnalysisActivity();
        Bus.emit("inflexa", {
            type: "prov.step_completed",
            analysisId: ANALYSIS,
            actor: ACTOR,
            outcome: { runId: "r1", stepId: "s", status: "completed", completedAtMs: 50_000 },
            model: "anthropic/claude-test",
        });
        Bus.emit("inflexa", runStarted(50_000, "no-such-analysis"));
        expect(activityAt()).toBe(CREATED);
    });

    test("the stop ends the subscription", () => {
        const unsubscribe = watchAnalysisActivity();
        unsubscribe();
        Bus.emit("inflexa", runStarted(5_000));
        expect(activityAt()).toBe(CREATED);
    });
});

describe("notifyProfileSettledActivity", () => {
    test("a settlement raises the activity to its completion time, and the notice gives ok", async () => {
        const completedAt = new Date(7_000).toISOString();

        const result = await notifyProfileSettledActivity({ analysisId: ANALYSIS, status: "completed", completedAt });

        expect(result.isOk()).toBe(true);
        expect(activityAt()).toBe(7_000);
    });

    test("a settlement of an unknown analysis changes nothing and still gives ok", async () => {
        const result = await notifyProfileSettledActivity({ analysisId: "nope", status: "failed", completedAt: new Date(7_000).toISOString() });

        expect(result.isOk()).toBe(true);
        expect(activityAt()).toBe(CREATED);
    });
});
