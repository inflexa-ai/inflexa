import type { DataProfileSettlement, NoticeFailure } from "@inflexa-ai/harness";
import { okAsync, type ResultAsync } from "neverthrow";

import { recordAnalysisActivity } from "../../db/primary_mutation.ts";
import { Bus } from "../../lib/bus.ts";
import { getLogger } from "../../lib/log.ts";
import type { StampedEvent } from "../../types/events.ts";

/**
 * Raises the activity time of an analysis to `atMs`. The time never goes lower, thus an event that fires
 * again after a recovery, or an event with an old time, changes nothing. A failure goes to the log and
 * fails no caller: the activity time orders a list, and the action that caused it already happened.
 */
export function noteAnalysisActivity(analysisId: string, atMs: number): void {
    recordAnalysisActivity(analysisId, atMs).match(
        () => undefined,
        (err) => getLogger("server").warn({ err, analysisId }, "could not record the activity of an analysis"),
    );
}

/** The analysis and the time of an activity that an event reports. */
type ActivityOfEvent = { analysisId: string; atMs: number };

/**
 * The activity that an event reports, or `null` when the event is no activity. A run event carries the time of
 * the durable clock, and it fires again after a recovery with the same time. An input event carries no time,
 * thus the time of its delivery stands for it. `run.observed` is no activity here: it carries no start or end
 * time.
 */
function activityOf(event: StampedEvent): ActivityOfEvent | null {
    switch (event.type) {
        case "prov.run_started":
            return { analysisId: event.analysisId, atMs: event.run.startedAtMs };
        case "prov.run_completed":
            return { analysisId: event.analysisId, atMs: event.outcome.completedAtMs };
        case "prov.input_added":
        case "prov.input_removed":
            return { analysisId: event.analysisId, atMs: Date.now() };
        default:
            return null;
    }
}

/**
 * Subscribes to the bus and raises the activity time of the analysis of each run start, run end, and input
 * change. Gives the unsubscribe.
 */
export function watchAnalysisActivity(): () => void {
    const handler = (event: StampedEvent): void => {
        const activity = activityOf(event);
        if (activity !== null) noteAnalysisActivity(activity.analysisId, activity.atMs);
    };
    Bus.on("inflexa", handler);
    return () => Bus.off("inflexa", handler);
}

/**
 * The realization of the settle notice of the harness data profile: the time of the profile end is an
 * activity of its analysis. The notice runs in the workflow body, and it fails nothing there.
 */
export function notifyProfileSettledActivity(settlement: DataProfileSettlement): ResultAsync<void, NoticeFailure> {
    noteAnalysisActivity(settlement.analysisId, Date.parse(settlement.completedAt));
    return okAsync(undefined);
}
