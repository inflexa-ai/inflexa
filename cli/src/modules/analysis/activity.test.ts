import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { insertAnalysis, insertAnchor } from "../../db/primary_mutation.ts";
import { listAnalysisPage } from "../../db/primary_query.ts";
import { Bus } from "../../lib/bus.ts";
import { asStr256 } from "../../lib/types.ts";
import { freshDb } from "../../test_support/db.ts";
import type { BusEvent } from "../../types/events.ts";
import { noteAnalysisActivity, notifyProfileSettledActivity, watchAnalysisActivity } from "./activity.ts";

const ANALYSIS = "analysis-1";
const CREATED = 1_000;

/** The activity time of the analysis, as the list page reads it. */
function activityAt(): number {
    return listAnalysisPage({ projectId: null, sort: "created", limit: 10, offset: 0 })
        ._unsafeUnwrap()
        .items.find((item) => item.analysis.id === ANALYSIS)!.lastActivityAt;
}

/** A bus event of the family that the watcher reads. The actor and the refs carry only what the test sets. */
function emit(event: Record<string, unknown>): void {
    // The watcher reads the type, the analysis id, and the time of the event only. The actor of the real
    // event is irrelevant to it, thus a partial event stands in for the full shape.
    Bus.emit("inflexa", { analysisId: ANALYSIS, actor: { kind: "system" }, ...event } as unknown as BusEvent);
}

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
        emit({ type: "prov.run_started", run: { runId: "r1", planSummary: "p", startedAtMs: 5_000 } });
        expect(activityAt()).toBe(5_000);
    });

    test("a run end takes the completion time of the outcome", () => {
        stop = watchAnalysisActivity();
        emit({ type: "prov.run_completed", outcome: { runId: "r1", status: "completed", completedAtMs: 8_000, durationMs: 3_000 } });
        expect(activityAt()).toBe(8_000);
    });

    test("an input add takes the time of its delivery", () => {
        stop = watchAnalysisActivity();
        const before = Date.now();
        emit({ type: "prov.input_added", input: { path: "a.csv", isDir: false, anchorId: null } });
        expect(activityAt()).toBeGreaterThanOrEqual(before);
    });

    test("an input removal takes the time of its delivery", () => {
        stop = watchAnalysisActivity();
        const before = Date.now();
        emit({ type: "prov.input_removed", input: { path: "a.csv", isDir: false, anchorId: null } });
        expect(activityAt()).toBeGreaterThanOrEqual(before);
    });

    test("a run event that fires again with the same time changes nothing", () => {
        stop = watchAnalysisActivity();
        const completed = { type: "prov.run_completed", outcome: { runId: "r1", status: "completed", completedAtMs: 8_000, durationMs: 1 } };
        emit(completed);
        emit(completed);
        expect(activityAt()).toBe(8_000);
    });

    test("an event with a time before the stored time does not lower it", () => {
        stop = watchAnalysisActivity();
        noteAnalysisActivity(ANALYSIS, 9_000);
        emit({ type: "prov.run_started", run: { runId: "r1", planSummary: "p", startedAtMs: 2_000 } });
        expect(activityAt()).toBe(9_000);
    });

    test("an event of another family, and an event of an unknown analysis, change nothing", () => {
        stop = watchAnalysisActivity();
        emit({ type: "prov.step_completed", outcome: { runId: "r1", stepId: "s", status: "completed", completedAtMs: 50_000 } });
        emit({ type: "prov.run_started", analysisId: "no-such-analysis", run: { runId: "r1", planSummary: "p", startedAtMs: 50_000 } });
        expect(activityAt()).toBe(CREATED);
    });

    test("the stop ends the subscription", () => {
        const unsubscribe = watchAnalysisActivity();
        unsubscribe();
        emit({ type: "prov.run_started", run: { runId: "r1", planSummary: "p", startedAtMs: 5_000 } });
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
