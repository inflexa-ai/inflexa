import { describe, expect, test } from "bun:test";
import { errAsync, ok, okAsync } from "neverthrow";
import { makeLocalAuth, type DataProfileStatus, type DataProfileTriggerParams } from "@inflexa-ai/harness";

import { ensureProfileAtParity, type ProfileParitySeams } from "./profile_trigger.ts";
import { seedProfileLedger } from "./profile.ts";
import type { HarnessRuntime } from "./runtime.ts";
import type { StagedInput } from "../staging/staging.ts";
import type { Analysis } from "../../types/analysis.ts";

// The parity ladder is exercised entirely offline: the ledger read, staging, seed, and trigger edges
// are injected as fakes (no Postgres, no Docker, no model), mirroring the BootSeams/SendSeams pattern.
// The happy path uses the REAL `seedProfileLedger` so the params reaching the trigger are exactly what
// `inflexa profile` builds — the seed's fileId mapping is verified via the fake pool's recorded query.

// Only `id`/`name` are read by the helper; the rest of the Analysis shape is inert here.
const ANALYSIS = { id: "a1", name: "My analysis" } as unknown as Analysis;

/** A full `DataProfileStatus` at the given lifecycle state (the helper only reads `.status`). */
function statusOf(status: DataProfileStatus["status"]): DataProfileStatus {
    return { status, error: null, startedAt: null, completedAt: null, result: null, seedInputFileIds: null };
}

/** A stub runtime whose pool/triggerDeps are never dereferenced (the seams stand in for every read). */
const stubRuntime = { pool: {}, triggerDeps: {} } as unknown as HarnessRuntime;

/** A staged manifest with two files, used for the happy path. */
const STAGED: StagedInput[] = [
    { fileId: "f1", mountName: "local", key: "a.csv", fileName: "a.csv", hash: "h1", size: 1, relativePath: "inputs/local/a.csv" },
    { fileId: "f2", mountName: "local", key: "b.csv", fileName: "b.csv", hash: "h2", size: 2, relativePath: "inputs/local/b.csv" },
];

/** Seams that record whether each downstream edge ran, so a skip can assert the ladder stopped early. */
function trackingSeams(over: Partial<ProfileParitySeams>): { seams: ProfileParitySeams; ran: { stage: boolean; seed: boolean; trigger: boolean } } {
    const ran = { stage: false, seed: false, trigger: false };
    const seams: ProfileParitySeams = {
        // Default: no orphaned row (the common case) — `false` = nothing reset.
        reconcile: () => okAsync(false),
        loadStatus: () => okAsync(null),
        stage: async () => {
            ran.stage = true;
            return ok(STAGED);
        },
        seed: () => {
            ran.seed = true;
            return okAsync({ auth: makeLocalAuth(), analysisId: ANALYSIS.id, stagedInputs: STAGED });
        },
        trigger: async () => {
            ran.trigger = true;
            return "started";
        },
        ...over,
    };
    return { seams, ran };
}

describe("ensureProfileAtParity — skip conditions", () => {
    test("a completed profile skips without staging/seeding/triggering", async () => {
        const { seams, ran } = trackingSeams({ loadStatus: () => okAsync(statusOf("completed")) });
        const outcome = await ensureProfileAtParity(stubRuntime, ANALYSIS, seams);
        expect(outcome).toEqual({ kind: "already_profiled" });
        expect(ran).toEqual({ stage: false, seed: false, trigger: false });
    });

    test("a running profile skips without staging/seeding/triggering", async () => {
        const { seams, ran } = trackingSeams({ loadStatus: () => okAsync(statusOf("running")) });
        const outcome = await ensureProfileAtParity(stubRuntime, ANALYSIS, seams);
        expect(outcome).toEqual({ kind: "already_running" });
        expect(ran).toEqual({ stage: false, seed: false, trigger: false });
    });

    test("an empty manifest is no_inputs — no seed/trigger", async () => {
        const { seams, ran } = trackingSeams({ loadStatus: () => okAsync(null), stage: async () => ok([] as StagedInput[]) });
        const outcome = await ensureProfileAtParity(stubRuntime, ANALYSIS, seams);
        expect(outcome).toEqual({ kind: "no_inputs" });
        expect(ran.seed).toBe(false);
        expect(ran.trigger).toBe(false);
    });

    test("a ledger read fault is failed (parity cannot be judged)", async () => {
        const { seams, ran } = trackingSeams({
            loadStatus: () => errAsync({ type: "query_failed", op: "loadDataProfileStatus", cause: new Error("db down") }),
        });
        const outcome = await ensureProfileAtParity(stubRuntime, ANALYSIS, seams);
        expect(outcome.kind).toBe("failed");
        expect(ran.stage).toBe(false);
    });
});

describe("ensureProfileAtParity — trigger path", () => {
    test("happy path triggers with the exact params inflexa profile builds", async () => {
        let capturedParams: DataProfileTriggerParams | null = null;
        const queries: { text: string; values: readonly unknown[] }[] = [];
        // A pool whose query resolves ok, so the REAL seedProfileLedger's upsert succeeds offline and
        // the fileId mapping it sends is observable.
        const runtime = {
            pool: {
                query: async (q: { text: string; values: readonly unknown[] }) => {
                    queries.push(q);
                    return { rows: [] };
                },
            },
            triggerDeps: {},
        } as unknown as HarnessRuntime;
        const seams: ProfileParitySeams = {
            reconcile: () => okAsync(false),
            loadStatus: () => okAsync(null),
            stage: async () => ok(STAGED),
            // The real shared core — this is the whole point of the assertion below.
            seed: seedProfileLedger,
            trigger: async (_deps, params) => {
                capturedParams = params;
                return "started";
            },
        };

        const outcome = await ensureProfileAtParity(runtime, ANALYSIS, seams);

        expect(outcome).toEqual({ kind: "triggered" });
        expect(capturedParams).not.toBeNull();
        // The params profile.ts builds: local auth, the cli analysis id, the manifest verbatim.
        expect(capturedParams!.analysisId).toBe(ANALYSIS.id);
        expect(capturedParams!.stagedInputs).toBe(STAGED);
        expect(capturedParams!.auth).toEqual(makeLocalAuth());
        // The seed upserted with exactly the staged file ids (the ledger contract's inputFileIds).
        const seedQuery = queries.find((q) => q.text.includes("cortex_analysis_state"));
        expect(seedQuery).toBeDefined();
        expect(seedQuery!.values).toContain(JSON.stringify(["f1", "f2"]));
    });

    test("a restarted trigger is also reported as triggered", async () => {
        const { seams } = trackingSeams({ trigger: async () => "restarted" });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "triggered" });
    });

    test("a trigger CAS lost to another attempt is already_running", async () => {
        const { seams } = trackingSeams({ trigger: async () => "already_running" });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_running" });
    });

    test("a trigger failure is failed with a reason", async () => {
        const { seams } = trackingSeams({ trigger: async () => "failed" });
        const outcome = await ensureProfileAtParity(stubRuntime, ANALYSIS, seams);
        expect(outcome.kind).toBe("failed");
        if (outcome.kind === "failed") expect(outcome.reason.length).toBeGreaterThan(0);
    });

    test("a seed fault is failed — no trigger", async () => {
        const { seams, ran } = trackingSeams({
            seed: () => errAsync({ type: "query_failed", op: "analyses.upsertAnalysis", cause: new Error("db down") }),
        });
        const outcome = await ensureProfileAtParity(stubRuntime, ANALYSIS, seams);
        expect(outcome.kind).toBe("failed");
        expect(ran.trigger).toBe(false);
    });
});

describe("ensureProfileAtParity — orphaned-profile reconcile (S2)", () => {
    test("a wedged running row is reconciled before the status read, then re-triggers", async () => {
        // Before reconcile the ledger shows `running` (the orphaned row); reconcile resets it, so the
        // status read AFTER it sees no active profile and the ladder proceeds to trigger. This asserts
        // both the ordering (reconcile precedes the status read) and the self-heal it enables — the
        // same behaviour `inflexa profile` gets from `reconcileOrphanedDataProfile` in profile.ts.
        let reconciled = false;
        const seams: ProfileParitySeams = {
            reconcile: () => {
                reconciled = true;
                return okAsync(true);
            },
            loadStatus: () => (reconciled ? okAsync(null) : okAsync(statusOf("running"))),
            stage: async () => ok(STAGED),
            seed: () => okAsync({ auth: makeLocalAuth(), analysisId: ANALYSIS.id, stagedInputs: STAGED }),
            trigger: async () => "started",
        };
        const outcome = await ensureProfileAtParity(stubRuntime, ANALYSIS, seams);
        expect(outcome).toEqual({ kind: "triggered" });
    });

    test("a reconcile fault is swallowed (best-effort) — parity still proceeds", async () => {
        const { seams } = trackingSeams({
            reconcile: () => errAsync({ type: "query_failed", op: "reconcileOrphanedDataProfile", cause: new Error("db blip") }),
        });
        // The reconcile fault must NOT abort parity: the status read + ladder run as normal.
        const outcome = await ensureProfileAtParity(stubRuntime, ANALYSIS, seams);
        expect(outcome).toEqual({ kind: "triggered" });
    });
});
