import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RunObservation, RunProvenanceEvent } from "@inflexa-ai/harness";

import { Bus } from "../../lib/bus.ts";
import type { StampedEvent } from "../../types/events.ts";
import type { ProvModelId } from "../../types/prov.ts";
import { createRunProvenanceEmitter } from "./prov_bridge.ts";
import { emitRunObservation } from "./run_bridge.ts";

// Bus-spy harness, matching `prov_bridge.test.ts`: capture every `inflexa` event and always detach
// in cleanup so a lingering listener never double-counts a later test's events.
let captured: StampedEvent[] = [];
function spy(event: StampedEvent): void {
    captured.push(event);
}
beforeEach(() => {
    captured = [];
    Bus.on("inflexa", spy);
});
afterEach(() => {
    Bus.off("inflexa", spy);
});

function observation(overrides: Partial<RunObservation> = {}): RunObservation {
    return {
        runId: "run-1",
        analysisId: "analysis-1",
        status: "running",
        steps: [
            { id: "T1S1", name: "quality control", agent: "bio-analyst", status: "completed", durationMs: 4200 },
            { id: "T1S2", name: "differential expression", agent: "bio-analyst", status: "running" },
            { id: "T1S3", name: "pathway enrichment", agent: "bio-analyst", status: "pending" },
        ],
        ...overrides,
    };
}

describe("run observation bridge", () => {
    test("maps an observation onto a run.observed bus event", () => {
        emitRunObservation(observation());

        expect(captured.length).toBe(1);
        const event = captured[0]!;
        if (event.type !== "run.observed") throw new Error(`expected run.observed, got ${event.type}`);
        expect(event.analysisId).toBe("analysis-1");
        expect(event.snapshot.runId).toBe("run-1");
        expect(event.snapshot.status).toBe("running");
        // The snapshot carries every step, including one that has not started.
        expect(event.snapshot.steps.map((s) => s.id)).toEqual(["T1S1", "T1S2", "T1S3"]);
        // Names and agents survive the mapping — they are the point of the seam.
        expect(event.snapshot.steps[1]!.name).toBe("differential expression");
        expect(event.snapshot.steps[1]!.agent).toBe("bio-analyst");
    });

    test("omits absent optional step fields rather than emitting undefined keys", () => {
        emitRunObservation(observation());

        const event = captured[0]!;
        if (event.type !== "run.observed") throw new Error("expected run.observed");
        const running = event.snapshot.steps.find((s) => s.id === "T1S2")!;
        expect("durationMs" in running).toBe(false);
        expect("error" in running).toBe(false);
        const done = event.snapshot.steps.find((s) => s.id === "T1S1")!;
        expect(done.durationMs).toBe(4200);
    });

    test("restates the snapshot rather than forwarding the harness object", () => {
        const source = observation();
        emitRunObservation(source);

        const event = captured[0]!;
        if (event.type !== "run.observed") throw new Error("expected run.observed");
        // Nothing mutable from the runtime reaches a subscriber: mutating the source afterwards
        // must not be visible on the emitted snapshot.
        expect(event.snapshot).not.toBe(source);
        expect(event.snapshot.steps).not.toBe(source.steps);
        expect(event.snapshot.steps[0]).not.toBe(source.steps[0]);
    });

    test("the run and provenance families are independent", () => {
        const provEvents: RunProvenanceEvent[] = [];
        const emitProv = createRunProvenanceEmitter("anthropic/claude" as ProvModelId);

        emitRunObservation(observation({ status: "completed" }));
        // Only `run.observed` — observing a run emits no provenance whatsoever.
        expect(captured.every((e) => e.type === "run.observed")).toBe(true);

        captured = [];
        emitProv({ type: "run_completed", analysisId: "analysis-1", runId: "run-1", status: "completed", atMs: 1, durationMs: 1 });
        // And the reverse: the provenance emitter produces no `run.*` event.
        expect(captured.every((e) => e.type === "prov.run_completed")).toBe(true);
        expect(provEvents.length).toBe(0);
    });
});
