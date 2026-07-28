import type { RunObservation } from "@inflexa-ai/harness";

import { Bus } from "../../lib/bus.ts";
import type { RunObservedSnapshot } from "../../types/events.ts";

// The cli↔harness RUN-OBSERVATION bridge. Deliberately a separate module from `prov_bridge.ts`
// rather than another function inside it: the two seams answer to different masters. Provenance
// closes a signed, hash-chained record under the per-analysis instance lock and must never drop an
// event; run observation is a presentation channel that tolerates loss entirely. Sharing a file
// would invite sharing a payload, and the first time someone "reused" a provenance event to drive a
// repaint, a UI refresh would start depending on the chain's write discipline.
//
// This bridge is also why the cli never subscribes to anything harness-owned: the harness has no
// bus at all. It exposes a callback dep, the composition root injects this realization, and the
// event lands on the cli's own bus — the same arrangement `emitProvenance` uses.

/**
 * Realize the harness's `observeRun` dep as a `run.observed` bus emission.
 *
 * A plain function rather than a factory: unlike `createRunProvenanceEmitter`, which binds the
 * boot-resolved model id, this binds nothing. The analysis id rides the observation — the run
 * engine is composed once per process, not per analysis, so the composition root does not know it;
 * the harness-supplied value equals the cli's by the trigger contract, exactly as the provenance
 * emitter already assumes.
 *
 * The mapping restates the snapshot into cli-owned primitives instead of forwarding the harness
 * object. Two reasons: nothing mutable from the runtime reaches a subscriber, and a widening of the
 * harness snapshot surfaces here as a compile error rather than as an unnoticed extra field flowing
 * to every consumer.
 *
 * Fire-and-forget, which is what the harness's guard expects: this never throws on its own, and the
 * harness swallows anything a subscriber propagates so a broken consumer cannot fail a run.
 */
export function emitRunObservation(observation: RunObservation): void {
    const snapshot: RunObservedSnapshot = {
        runId: observation.runId,
        status: observation.status,
        steps: observation.steps.map((s) => ({
            id: s.id,
            name: s.name,
            agent: s.agent,
            status: s.status,
            ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}),
            ...(s.error !== undefined ? { error: s.error } : {}),
        })),
    };
    Bus.emit("inflexa", { type: "run.observed", analysisId: observation.analysisId, snapshot });
}
