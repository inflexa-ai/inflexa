import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { isLowerHexOfLength } from "../../lib/test/text-shapes.js";
import { ResultAsync, errAsync, okAsync } from "neverthrow";
import type { Pool } from "pg";

import type { Querier } from "../../state/db.js";

import { withSchema } from "../../__tests__/setup/postgres.js";
import { makeLocalAuth } from "../../auth/local-auth-context.js";
import { createLocalRunAuthorizer } from "../../auth/local-run-authorizer.js";
import type { StagedInput } from "../../execution/staged-input.js";
import type { RunLauncher } from "../../execution/run-launcher.js";
import type { SignableInput } from "../../execution/input-signature.js";
import { loadDataProfileStatus, tryRetryDataProfile } from "../../state/data-profile.js";
import { computeInputSignature } from "../../execution/input-signature.js";
import { runDataProfile, triggerDataProfile, type DataProfileTriggerDeps } from "../data-profile.js";

/**
 * A minimal, well-formed staged-input manifest entry. The trigger forwards the
 * manifest into the workflow input unread — it only validates that a non-empty
 * manifest backs a seeded row — so these fields need not match the seed set.
 */
function stagedInput(fileId: string): StagedInput {
    return {
        fileId,
        mountName: fileId,
        key: `${fileId}.csv`,
        fileName: `${fileId}.csv`,
        hash: `hash-${fileId}`,
        size: 1024,
        mtimeMs: 1_780_000_000_000,
        relativePath: `inputs/${fileId}/${fileId}.csv`,
    };
}

/**
 * A staged input as a pre-`mtimeMs` deploy persisted it: the `mtimeMs` key is
 * absent from the deserialized object despite the required-`number` type. This is
 * the recovered-legacy shape the input signature has to digest around.
 */
function legacyStagedInput(fileId: string): SignableInput {
    const { mtimeMs: _dropped, ...legacy } = stagedInput(fileId);
    return legacy;
}

/** No DBOS engine runs in this file, thus each start of the launcher rejects, as a start of the engine would. */
const noEngineLauncher: RunLauncher = { launch: () => Promise.reject(new Error("no DBOS engine runs in this file")) };

/**
 * Seed a `cortex_analysis_state` row at the given `data_profile_status` (pass `null`
 * for the cleared/never-profiled state). Mirrors the helper in
 * `state/test/data-profile.test.ts`: it leaves `seed_input_file_ids` NULL, which is
 * exactly the unseeded state that the claim CAS refuses, and that the trigger's guard
 * refuses when the manifest names files.
 */
async function seedAnalysis(pool: Querier, analysisId: string, dpStatus: string | null = "pending"): Promise<void> {
    const now = new Date().toISOString();
    await pool.query({
        text: `INSERT INTO cortex_analysis_state
           (analysis_id, status, context, data_profile_status, created_at, updated_at)
           VALUES ($1, 'active', NULL, $2, $3, $4)`,
        values: [analysisId, dpStatus, now, now],
    });
}

/** Write `seed_input_file_ids` directly — the column the guard and the CAS both read. */
async function setSeed(pool: Querier, analysisId: string, seed: string[] | null): Promise<void> {
    await pool.query({
        text: `UPDATE cortex_analysis_state SET seed_input_file_ids = $1::jsonb WHERE analysis_id = $2`,
        values: [seed === null ? null : JSON.stringify(seed), analysisId],
    });
}

/**
 * Deps whose `authorize` never settles. The trigger dispatches the workflow
 * fire-and-forget through the launcher; with no DBOS engine that dispatch
 * rejects and the trigger's compensation flips the freshly-claimed `running` row back
 * to `failed`. Parking `authorize` — the first await on the fire-and-forget path —
 * holds the dispatch open so compensation can never race our read of the committed CAS
 * result. The guard and the claim both run to completion upstream of that await.
 */
function parkedDispatchDeps(pool: Querier): DataProfileTriggerDeps {
    return {
        pool,
        runAuthorizer: {
            authorize: () => new ResultAsync(new Promise(() => {})),
            revoke: () => okAsync(undefined),
            revokeByMandateId: () => okAsync(undefined),
            suspend: () => okAsync(undefined),
            renew: () => okAsync(undefined),
        },
        runLauncher: noEngineLauncher,
        workflow: async () => {},
    };
}

/**
 * Deps whose `workflow` throws if it is ever invoked. Note the throw cannot
 * actually fire in these tests: the trigger dispatches through the launcher,
 * which — with no DBOS engine launched — rejects before `deps.workflow` is reached,
 * and that rejection is swallowed by the fire-and-forget `.catch(compensateStartFailure)`.
 * So a regression that let an unseeded or empty-manifest row through would NOT surface
 * as a thrown error. It surfaces through the assertions in each test instead:
 * `expect(result).toBe("failed")` plus the `rawStatus` check that the row was never
 * claimed into `running`. The throwing body only documents the contract that
 * `deps.workflow` must stay unreached on every refusal path.
 */
function tripwireDeps(pool: Querier): DataProfileTriggerDeps {
    return {
        pool,
        runAuthorizer: createLocalRunAuthorizer(),
        runLauncher: noEngineLauncher,
        workflow: () => {
            throw new Error("workflow must not be launched for an unseeded trigger");
        },
    };
}

/** Read `data_profile_status` straight off the row, bypassing the NULL-collapse
 * in `loadDataProfileStatus`. */
async function rawStatus(pool: Querier, analysisId: string): Promise<string | null> {
    const res = await pool.query<{ data_profile_status: string | null }>({
        text: "SELECT data_profile_status FROM cortex_analysis_state WHERE analysis_id = $1",
        values: [analysisId],
    });
    return res.rows[0]?.data_profile_status ?? null;
}

describe("triggerDataProfile seed-first guard", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("dp_trigger_guard");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    it("refuses a NULL-seed row dispatched a manifest that names files, and leaves it unclaimed", async () => {
        // `seedAnalysis` leaves `seed_input_file_ids` NULL. The manifest names a file, so
        // the caller skipped the seed: the trigger refuses before any claim.
        await seedAnalysis(pool, "a-noseed", "pending");

        const result = (
            await triggerDataProfile(tripwireDeps(pool), {
                auth: makeLocalAuth(),
                analysisId: "a-noseed",
                stagedInputs: [stagedInput("file-aaa")],
            })
        )._unsafeUnwrap();

        expect(result).toBe("failed");

        // State, not interactions: the row is untouched at 'pending' — never claimed.
        expect(await rawStatus(pool, "a-noseed")).toBe("pending");
        const status = (await loadDataProfileStatus(pool, "a-noseed"))._unsafeUnwrap();
        expect(status?.status).toBe("pending");
    });

    it("refuses an empty-seed row dispatched a manifest that names files — `[]` is not a seed", async () => {
        // `upsertAnalysis` writes NULL to mean "leave the stored seed alone", so `[]`
        // reaches the ledger as a real value. Against a manifest that names a file, it
        // must be refused exactly like NULL.
        await seedAnalysis(pool, "a-emptyseed", "pending");
        await setSeed(pool, "a-emptyseed", []);

        const result = (
            await triggerDataProfile(tripwireDeps(pool), {
                auth: makeLocalAuth(),
                analysisId: "a-emptyseed",
                stagedInputs: [stagedInput("file-aaa")],
            })
        )._unsafeUnwrap();

        expect(result).toBe("failed");
        expect(await rawStatus(pool, "a-emptyseed")).toBe("pending");
    });

    it("completes a NULL-seed row dispatched an empty manifest — no input files, no workflow", async () => {
        // The never-profiled analysis with no inputs. Nothing to profile, so the row is
        // `completed` at once. `tripwireDeps` documents that no workflow is launched.
        await seedAnalysis(pool, "a-empty-noseed", null);

        const result = (
            await triggerDataProfile(tripwireDeps(pool), {
                auth: makeLocalAuth(),
                analysisId: "a-empty-noseed",
                stagedInputs: [],
            })
        )._unsafeUnwrap();

        expect(result).toBe("completed");
        expect(await rawStatus(pool, "a-empty-noseed")).toBe("completed");
        const status = (await loadDataProfileStatus(pool, "a-empty-noseed"))._unsafeUnwrap();
        expect(status?.status).toBe("completed");
        expect(status?.result).toBeNull();
        expect(status?.workflowId).toBeNull();
        expect(status?.seedInputFileIds).toEqual([]);
    });

    it("completes an empty-seed pending row dispatched an empty manifest", async () => {
        // The caller seeded `[]` and forwarded an empty manifest: the two agree that the
        // analysis has no input files.
        await seedAnalysis(pool, "a-empty-seeded", "pending");
        await setSeed(pool, "a-empty-seeded", []);

        const result = (
            await triggerDataProfile(tripwireDeps(pool), {
                auth: makeLocalAuth(),
                analysisId: "a-empty-seeded",
                stagedInputs: [],
            })
        )._unsafeUnwrap();

        expect(result).toBe("completed");
        expect(await rawStatus(pool, "a-empty-seeded")).toBe("completed");
    });

    it("reports already_running for an empty manifest against a live run", async () => {
        // A live workflow owns the row. The empty-set stamp refuses it, and the trigger
        // names the cause from the status instead of a bare failure.
        await seedAnalysis(pool, "a-empty-running", "running");
        await setSeed(pool, "a-empty-running", []);

        const result = (
            await triggerDataProfile(tripwireDeps(pool), {
                auth: makeLocalAuth(),
                analysisId: "a-empty-running",
                stagedInputs: [],
            })
        )._unsafeUnwrap();

        expect(result).toBe("already_running");
        expect(await rawStatus(pool, "a-empty-running")).toBe("running");
    });

    it("fails an empty manifest for an analysis with no ledger row", async () => {
        const result = (
            await triggerDataProfile(tripwireDeps(pool), {
                auth: makeLocalAuth(),
                analysisId: "a-empty-norow",
                stagedInputs: [],
            })
        )._unsafeUnwrap();

        expect(result).toBe("failed");
        expect(await rawStatus(pool, "a-empty-norow")).toBeNull();
    });

    it("claims a NULL-status seeded row — the cleared-then-reseeded state", async () => {
        // THE production lifecycle this guard was written for, and the one the claim's
        // `data_profile_status IS NULL` clause exists to serve: `clearDataProfile` nulls
        // status AND seed; a later seed upsert repopulates the seed via COALESCE without
        // ever rewriting status. Seeding 'pending' here instead would let the CAS's
        // pre-existing `= 'pending'` branch win, and the NULL clause would go untested.
        await seedAnalysis(pool, "a-cleared", null);
        await setSeed(pool, "a-cleared", ["file-aaa", "file-bbb"]);

        const result = (
            await triggerDataProfile(parkedDispatchDeps(pool), {
                auth: makeLocalAuth(),
                analysisId: "a-cleared",
                stagedInputs: [stagedInput("file-aaa")],
            })
        )._unsafeUnwrap();

        expect(result).toBe("started");
        expect(await rawStatus(pool, "a-cleared")).toBe("running");
    });

    it("claims a pending seeded row", async () => {
        await seedAnalysis(pool, "a-seeded", "pending");
        await setSeed(pool, "a-seeded", ["file-aaa", "file-bbb"]);

        const result = (
            await triggerDataProfile(parkedDispatchDeps(pool), {
                auth: makeLocalAuth(),
                analysisId: "a-seeded",
                stagedInputs: [stagedInput("file-aaa")],
            })
        )._unsafeUnwrap();

        expect(result).toBe("started");
        expect(await rawStatus(pool, "a-seeded")).toBe("running");
        const status = (await loadDataProfileStatus(pool, "a-seeded"))._unsafeUnwrap();
        expect(status?.status).toBe("running");
    });

    it("re-claims a completed seeded row as a restart", async () => {
        await seedAnalysis(pool, "a-completed", "completed");
        await setSeed(pool, "a-completed", ["file-aaa"]);

        const result = (
            await triggerDataProfile(parkedDispatchDeps(pool), {
                auth: makeLocalAuth(),
                analysisId: "a-completed",
                stagedInputs: [stagedInput("file-aaa")],
            })
        )._unsafeUnwrap();

        expect(result).toBe("restarted");
        expect(await rawStatus(pool, "a-completed")).toBe("running");
    });

    it("refuses a seeded row dispatched an EMPTY manifest — the seed names files the manifest does not", async () => {
        // The manifest divergence the trigger closes: the ledger seed names files, but the
        // caller forwarded `stagedInputs: []`. Left through, the claim would flip `running`
        // and the body's empty-manifest path would complete with a NULL result — the exact
        // seedless-completed incoherence a staleness policy loops on. The refusal must land
        // BEFORE any claim, so the row stays untouched at its seeded status.
        await seedAnalysis(pool, "a-empty-manifest", "pending");
        await setSeed(pool, "a-empty-manifest", ["file-aaa", "file-bbb"]);

        const result = (
            await triggerDataProfile(tripwireDeps(pool), {
                auth: makeLocalAuth(),
                analysisId: "a-empty-manifest",
                stagedInputs: [],
            })
        )._unsafeUnwrap();

        expect(result).toBe("failed");
        expect(await rawStatus(pool, "a-empty-manifest")).toBe("pending");
        const status = (await loadDataProfileStatus(pool, "a-empty-manifest"))._unsafeUnwrap();
        expect(status?.status).toBe("pending");
    });

    it("a seed wiped after the guard's read cannot produce a seedless running row", async () => {
        // The TOCTOU the CAS conjunct closes. The guard's pre-read is advisory: here it
        // observes a seed that a concurrent `clearDataProfile` then wipes. A non-empty
        // manifest is passed so flow reaches the CAS (an empty one would be refused earlier
        // by the manifest guard, never exercising the race). The claim must still refuse,
        // because a `running` row that names no input set is the state the whole invariant
        // exists to forbid.
        await seedAnalysis(pool, "a-raced", null);
        await setSeed(pool, "a-raced", ["file-aaa"]);

        const raced: DataProfileTriggerDeps = {
            ...tripwireDeps(pool),
            pool: {
                // Wipe the seed the instant the guard finishes reading it, before the CAS runs.
                query: async (...args: Parameters<Querier["query"]>) => {
                    const res = await pool.query(...args);
                    const first = args[0];
                    const text = typeof first === "string" ? first : first.text;
                    if (text.includes("SELECT seed_input_file_ids")) await setSeed(pool, "a-raced", null);
                    return res;
                },
            },
        };

        const result = (
            await triggerDataProfile(raced, {
                auth: makeLocalAuth(),
                analysisId: "a-raced",
                stagedInputs: [stagedInput("file-aaa")],
            })
        )._unsafeUnwrap();

        expect(result).toBe("failed");
        expect(await rawStatus(pool, "a-raced")).toBeNull();
    });

    it("gives a failed ledger read as its err, not as a `failed` outcome", async () => {
        const faulty: DataProfileTriggerDeps = {
            ...tripwireDeps(pool),
            pool: { query: async () => Promise.reject(new Error("connection terminated")) },
        };

        const failure = (
            await triggerDataProfile(faulty, { auth: makeLocalAuth(), analysisId: "a-faulty", stagedInputs: [stagedInput("file-aaa")] })
        )._unsafeUnwrapErr();

        expect(failure.op).toBe("dataProfile.loadSeedInputFileIds");
    });
});

describe("triggerDataProfile — a refused authorization", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("dp_trigger_refused");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    function refusingDeps(suspend: boolean): DataProfileTriggerDeps {
        return {
            pool,
            runAuthorizer: {
                authorize: () => errAsync({ reason: "no_funds", suspend }),
                revoke: () => okAsync(undefined),
                revokeByMandateId: () => okAsync(undefined),
                suspend: () => okAsync(undefined),
                renew: () => okAsync(undefined),
            },
            runLauncher: noEngineLauncher,
            workflow: () => {
                throw new Error("workflow must not be launched after a refused authorization");
            },
        };
    }

    /** The fire-and-forget dispatch settles after the trigger returns, thus the test waits for the row. */
    async function settledStatus(analysisId: string): Promise<string | null> {
        const deadline = Date.now() + 5_000;
        let status = await rawStatus(pool, analysisId);
        while (status === "running" && Date.now() < deadline) {
            await sleep(20);
            status = await rawStatus(pool, analysisId);
        }
        return status;
    }

    async function analysisStatus(analysisId: string): Promise<string | null> {
        const res = await pool.query<{ status: string }>({ text: "SELECT status FROM cortex_analysis_state WHERE analysis_id = $1", values: [analysisId] });
        return res.rows[0]?.status ?? null;
    }

    it("starts no workflow, fails the claimed row with the reason of the host, and leaves the analysis active", async () => {
        await seedAnalysis(pool, "a-refused", "pending");
        await setSeed(pool, "a-refused", ["file-aaa"]);

        expect(
            (
                await triggerDataProfile(refusingDeps(false), { auth: makeLocalAuth(), analysisId: "a-refused", stagedInputs: [stagedInput("file-aaa")] })
            )._unsafeUnwrap(),
        ).toBe("started");

        expect(await settledStatus("a-refused")).toBe("failed");
        const status = (await loadDataProfileStatus(pool, "a-refused"))._unsafeUnwrap();
        expect(status?.error).toBe("no_funds");
        expect(await analysisStatus("a-refused")).toBe("active");
    });

    it("with the suspend flag, fails the claimed row the same way, and leaves the analysis active", async () => {
        await seedAnalysis(pool, "a-refused-suspend", "pending");
        await setSeed(pool, "a-refused-suspend", ["file-aaa"]);

        expect(
            (
                await triggerDataProfile(refusingDeps(true), {
                    auth: makeLocalAuth(),
                    analysisId: "a-refused-suspend",
                    stagedInputs: [stagedInput("file-aaa")],
                })
            )._unsafeUnwrap(),
        ).toBe("started");

        expect(await settledStatus("a-refused-suspend")).toBe("failed");
        expect((await loadDataProfileStatus(pool, "a-refused-suspend"))._unsafeUnwrap()?.error).toBe("no_funds");
        expect(await analysisStatus("a-refused-suspend")).toBe("active");
    });
});

// The workflow body builds the completed profile's drift comparand from the staged
// manifest. A manifest recovered from before `StagedInput.mtimeMs` existed lacks that
// field; the signature digests it as absent rather than dropping the comparand, so an
// added or resized file is still detected. Pure — no DB, no container.
describe("computeInputSignature over a recovered legacy manifest", () => {
    it("still produces a comparand when an entry lacks mtimeMs", () => {
        const sig = computeInputSignature([stagedInput("file-aaa"), legacyStagedInput("file-legacy")]);
        expect(sig.count).toBe(2);
        expect(isLowerHexOfLength(sig.digest, 64)).toBe(true);
    });

    it("differs from the same set with its mtimes intact, so the gap is not silently equal", () => {
        const legacy = computeInputSignature([stagedInput("file-aaa"), legacyStagedInput("file-bbb")]);
        const complete = computeInputSignature([stagedInput("file-aaa"), stagedInput("file-bbb")]);
        expect(legacy.digest).not.toBe(complete.digest);
    });
});

describe("runDataProfile — the outcome of the dispatch", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("dp_run_outcome");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    /** A `failed` row that the retry claim moved to `running`, the state in which a caller calls `runDataProfile`. */
    async function claimFailedRow(analysisId: string): Promise<void> {
        await seedAnalysis(pool, analysisId, "failed");
        await setSeed(pool, analysisId, ["file-aaa"]);
        expect((await tryRetryDataProfile(pool, analysisId))._unsafeUnwrap()).toBe(true);
    }

    for (const suspend of [false, true]) {
        it(`gives a refused authorization with suspend ${String(suspend)} as its err, after it fails the row, and leaves the analysis active`, async () => {
            const analysisId = `a-run-refused-${String(suspend)}`;
            await claimFailedRow(analysisId);
            const refusing: DataProfileTriggerDeps = {
                pool,
                runAuthorizer: {
                    authorize: () => errAsync({ reason: "no_funds", suspend }),
                    revoke: () => okAsync(undefined),
                    revokeByMandateId: () => okAsync(undefined),
                    suspend: () => okAsync(undefined),
                    renew: () => okAsync(undefined),
                },
                runLauncher: noEngineLauncher,
                workflow: () => {
                    throw new Error("workflow must not be launched after a refused authorization");
                },
            };

            const failure = (await runDataProfile(refusing, { auth: makeLocalAuth(), analysisId, stagedInputs: [stagedInput("file-aaa")] }))._unsafeUnwrapErr();

            expect(failure).toEqual({ type: "refused", reason: "no_funds", suspend });
            expect(await rawStatus(pool, analysisId)).toBe("failed");
            expect((await loadDataProfileStatus(pool, analysisId))._unsafeUnwrap()?.error).toBe("no_funds");
            const analysis = await pool.query<{ status: string }>({
                text: "SELECT status FROM cortex_analysis_state WHERE analysis_id = $1",
                values: [analysisId],
            });
            expect(analysis.rows[0]?.status).toBe("active");
        });
    }

    it("gives a failed start as its err, after it compensates the row", async () => {
        // No DBOS engine runs in this file, thus the start of the launcher rejects.
        await claimFailedRow("a-run-start-failed");

        const failure = (
            await runDataProfile(tripwireDeps(pool), { auth: makeLocalAuth(), analysisId: "a-run-start-failed", stagedInputs: [stagedInput("file-aaa")] })
        )._unsafeUnwrapErr();

        expect(failure.type).toBe("start_failed");
        expect(await rawStatus(pool, "a-run-start-failed")).toBe("failed");
    });
});
