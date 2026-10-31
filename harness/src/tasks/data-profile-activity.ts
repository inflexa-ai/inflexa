/**
 * The data-profile workflow's activity emissions, as a pure factory over a raw
 * stream write.
 *
 * Extracted from the workflow body for the same reason `createLineageCollector`
 * and `buildDriftSignature` are: a DBOS workflow body is not reachable from a
 * unit test — it needs a launched engine, a sandbox, a scripted model, and an
 * embedder — so the decidable part is lifted out and tested on its own. What is
 * decidable here is the whole observable contract of this capability: which
 * phase each moment of a profile reports, and in what words. Those phrases are
 * what a user reads, so they are the one part of the work that must not be left
 * to drift.
 *
 * What stays in the body is only control flow — where each call sits relative to
 * the ledger writes. That is not extractable, and the ordering property it
 * carries (exactly one terminal emission) is guaranteed structurally instead:
 * there is exactly one `complete` call site and it is the last statement of the
 * success path, after the terminal ledger write and the authorization revoke, so
 * anything that throws on the way there reaches the failure path having emitted
 * no terminal at all.
 */

import type { StepPhase } from "../contracts/chat-parts.js";
import type { Logger } from "../lib/logger.js";
import { activityEmission, activityForTool, toolActivityKey } from "../sandbox/sandbox-step-translate.js";

/**
 * Writes one part to the run-event stream. Injected rather than imported so this
 * module stays free of the durability engine and so a test can record what a
 * profile would have reported without launching one.
 */
export type ActivityWrite = (part: unknown) => Promise<void>;

/**
 * The profile's activity channel. One method per moment the body reports, rather
 * than a generic `emit(phase, text)`: the phrases are normative, and a call site
 * that passes its own string is a call site that can drift from the spec.
 *
 * Every method resolves even when the underlying write fails — see
 * {@link createProfileActivityEmitter}.
 *
 * Five of the contract's phases have no method here, and their absence is a
 * decision rather than an oversight: `generating-metadata` and
 * `generating-summary` describe the sandbox-step's post-agent pipeline, which a
 * profile does not run (its agent delivers everything through `submit_profile`);
 * `persisting` is defined as step bytes uploading to an artifact store, and a
 * profile's durable products are the vector index and the ledger row, so it would
 * describe nothing; `retrying` needs a retry loop, and a profile failure is
 * terminal with recovery being a fresh attempt; `warning` needs a non-fatal
 * user-facing warning channel, and the body's two soft conditions (an empty
 * manifest, a fallback file description) are logged because neither warrants
 * interrupting the activity line.
 */
export type ProfileActivityEmitter = {
    /** Reported before the sandbox is created — the longest wait in a profile, and the one that precedes the agent entirely. */
    sandboxInit(): Promise<void>;
    /**
     * Reported before the deterministic input scan, which runs between a ready sandbox
     * and the agent's first turn. On a large tree it is the second-longest operation in
     * a profile, and left unreported it would read as `Running data-profiler` for
     * minutes before the agent had begun — the misreport `sandbox-init` exists to
     * prevent.
     */
    scanning(): Promise<void>;
    /** Reported once the sandbox is ready, covering the gap before the agent's first tool call. */
    agentStarting(): Promise<void>;
    /**
     * Reported per tool call the profiler agent makes, phrased by the shared
     * translator.
     *
     * `detail` is the detail of the loop event, which the `describeCall` hook of
     * the called tool made. The call site supplies a detail, never a phrase: the
     * phrases are this capability's observable contract, and a call site that
     * composed its own is a call site that can drift from it.
     */
    forTool(toolUseId: string, name: string, detail?: string): Promise<void>;
    /** Reported for the vector-store pass that indexes per-file descriptions. */
    indexing(): Promise<void>;
    /** The success terminal. Emitted only after the terminal ledger write has landed. */
    complete(): Promise<void>;
    /** The failure terminal, carrying the same user-safe reason the ledger receives. */
    failed(reason: string): Promise<void>;
};

/** Identity the emitted parts carry — the workflow's synthetic frame, not a real run. */
export type ProfileActivityFrame = {
    /**
     * The constant literal the data-profile workflow uses as its run id. It is the
     * same string for every analysis, so it identifies nothing; consumers are
     * required not to key on it (see the data-profile-observation spec). It is
     * carried because the part contract requires the field and because this is the
     * frame the workflow already uses for its sandbox identity and scratch path.
     */
    readonly runId: string;
    /** The constant literal step id of the profile's single synthetic step. */
    readonly stepId: string;
};

/**
 * Build the profile's activity channel over `write`.
 *
 * Every emission is awaited by its caller in body order, because `DBOS.writeStream`
 * allocates a function id and an unawaited write would race the next real operation
 * for the counter, desynchronising the recorded sequence on replay.
 *
 * A failing write is swallowed and logged, never propagated: observation is a
 * diagnostic channel, and a dropped frame must not fail a profile that is otherwise
 * succeeding. This mirrors the sandbox-step producer's stance on the same write.
 *
 * Each emission writes the reconciling activity part, so a late subscriber folds to the
 * current activity, and then one `data-activity-entry`, so it also gets each earlier line.
 * The two parts carry one time from `now`, which the body binds to the checkpointed clock of
 * its workflow. The two writes fail alone. The sequence number of the entry advances before
 * the clock read and the writes, thus a failure cannot shift a later id.
 */
export function createProfileActivityEmitter(
    write: ActivityWrite,
    frame: ProfileActivityFrame,
    logger: Logger,
    now: () => Promise<number>,
): ProfileActivityEmitter {
    let seq = 0;

    const writeAlone = async (part: unknown, phase: StepPhase): Promise<void> => {
        try {
            await write(part);
        } catch (err) {
            logger.warn("run-event write failed (non-fatal)", { phase, ...logger.errorFields(err) });
        }
    };

    const emit = async (phase: StepPhase, activity: string, toolUseId?: string): Promise<void> => {
        const key = toolUseId === undefined ? seq++ : toolActivityKey(toolUseId);
        const at = new Date(await now()).toISOString();
        const parts = activityEmission(frame, key, phase, activity, at);
        await writeAlone(parts.activity, phase);
        await writeAlone(parts.entry, phase);
    };

    return {
        sandboxInit: () => emit("sandbox-init", "Starting sandbox"),
        scanning: () => emit("executing", "Scanning input files"),
        agentStarting: () => emit("executing", "Running data-profiler"),
        forTool: (toolUseId, name, detail) => emit("executing", activityForTool(name, detail), toolUseId),
        indexing: () => emit("indexing", "Indexing input descriptions for search"),
        complete: () => emit("complete", "Profile complete"),
        failed: (reason) => emit("failed", reason),
    };
}
