import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { makeLocalAuth } from "../auth/local-auth-context.js";
import { createLocalRunAuthorizer } from "../auth/local-run-authorizer.js";
import type { StagedInput } from "../execution/staged-input.js";
import { loadDataProfileStatus } from "../state/data-profile.js";
import { buildDriftSignature, triggerDataProfile, type DataProfileTriggerDeps } from "./data-profile.js";

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
 * the recovered-legacy shape `buildDriftSignature` must detect and omit around.
 */
function legacyStagedInput(fileId: string): StagedInput {
    const { mtimeMs: _dropped, ...legacy } = stagedInput(fileId);
    return legacy as StagedInput;
}

/**
 * Seed a `cortex_analysis_state` row at the given `data_profile_status` (pass `null`
 * for the cleared/never-profiled state). Mirrors the helper in
 * `state/data-profile.test.ts`: it leaves `seed_input_file_ids` NULL, which is
 * exactly the unseeded state both the trigger's guard and the claim CAS refuse.
 */
async function seedAnalysis(pool: Pool, analysisId: string, dpStatus: string | null = "pending"): Promise<void> {
    const now = new Date().toISOString();
    await pool.query({
        text: `INSERT INTO cortex_analysis_state
           (analysis_id, status, context, data_profile_status, created_at, updated_at)
           VALUES ($1, 'active', NULL, $2, $3, $4)`,
        values: [analysisId, dpStatus, now, now],
    });
}

/** Write `seed_input_file_ids` directly — the column the guard and the CAS both read. */
async function setSeed(pool: Pool, analysisId: string, seed: string[] | null): Promise<void> {
    await pool.query({
        text: `UPDATE cortex_analysis_state SET seed_input_file_ids = $1::jsonb WHERE analysis_id = $2`,
        values: [seed === null ? null : JSON.stringify(seed), analysisId],
    });
}

/**
 * Deps whose `authorize` never settles. The trigger dispatches the workflow
 * fire-and-forget through `DBOS.startWorkflow`; with no DBOS engine that dispatch
 * rejects and the trigger's compensation flips the freshly-claimed `running` row back
 * to `failed`. Parking `authorize` — the first await on the fire-and-forget path —
 * holds the dispatch open so compensation can never race our read of the committed CAS
 * result. The guard and the claim both run to completion upstream of that await.
 */
function parkedDispatchDeps(pool: Pool): DataProfileTriggerDeps {
    return {
        pool,
        runAuthorizer: {
            authorize: () => new Promise(() => {}),
            async revoke() {},
        },
        workflow: async () => {},
    };
}

/**
 * Deps whose `workflow` throws if it is ever invoked. Note the throw cannot
 * actually fire in these tests: the trigger dispatches through `DBOS.startWorkflow`,
 * which — with no DBOS engine launched — rejects before `deps.workflow` is reached,
 * and that rejection is swallowed by the fire-and-forget `.catch(compensateStartFailure)`.
 * So a regression that let an unseeded or empty-manifest row through would NOT surface
 * as a thrown error. It surfaces through the assertions in each test instead:
 * `expect(result).toBe("failed")` plus the `rawStatus` check that the row was never
 * claimed into `running`. The throwing body only documents the contract that
 * `deps.workflow` must stay unreached on every refusal path.
 */
function tripwireDeps(pool: Pool): DataProfileTriggerDeps {
    return {
        pool,
        runAuthorizer: createLocalRunAuthorizer(),
        workflow: () => {
            throw new Error("workflow must not be launched for an unseeded trigger");
        },
    };
}

/** Read `data_profile_status` straight off the row, bypassing the NULL-collapse
 * in `loadDataProfileStatus`. */
async function rawStatus(pool: Pool, analysisId: string): Promise<string | null> {
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

    it("refuses a NULL-seed row and leaves it unclaimed", async () => {
        // `seedAnalysis` leaves `seed_input_file_ids` NULL — the unseeded ledger.
        await seedAnalysis(pool, "a-noseed", "pending");

        const result = await triggerDataProfile(tripwireDeps(pool), {
            auth: makeLocalAuth(),
            analysisId: "a-noseed",
            stagedInputs: [],
        });

        expect(result).toBe("failed");

        // State, not interactions: the row is untouched at 'pending' — never claimed.
        expect(await rawStatus(pool, "a-noseed")).toBe("pending");
        const status = (await loadDataProfileStatus(pool, "a-noseed"))._unsafeUnwrap();
        expect(status?.status).toBe("pending");
    });

    it("refuses an empty-seed row — `[]` names zero files, and is not a seed", async () => {
        // `upsertAnalysis` writes NULL to mean "leave the stored seed alone", so `[]`
        // reaches the ledger as a real value. It must be refused exactly like NULL.
        await seedAnalysis(pool, "a-emptyseed", "pending");
        await setSeed(pool, "a-emptyseed", []);

        const result = await triggerDataProfile(tripwireDeps(pool), {
            auth: makeLocalAuth(),
            analysisId: "a-emptyseed",
            stagedInputs: [],
        });

        expect(result).toBe("failed");
        expect(await rawStatus(pool, "a-emptyseed")).toBe("pending");
    });

    it("claims a NULL-status seeded row — the cleared-then-reseeded state", async () => {
        // THE production lifecycle this guard was written for, and the one the claim's
        // `data_profile_status IS NULL` clause exists to serve: `clearDataProfile` nulls
        // status AND seed; a later seed upsert repopulates the seed via COALESCE without
        // ever rewriting status. Seeding 'pending' here instead would let the CAS's
        // pre-existing `= 'pending'` branch win, and the NULL clause would go untested.
        await seedAnalysis(pool, "a-cleared", null);
        await setSeed(pool, "a-cleared", ["file-aaa", "file-bbb"]);

        const result = await triggerDataProfile(parkedDispatchDeps(pool), {
            auth: makeLocalAuth(),
            analysisId: "a-cleared",
            stagedInputs: [stagedInput("file-aaa")],
        });

        expect(result).toBe("started");
        expect(await rawStatus(pool, "a-cleared")).toBe("running");
    });

    it("claims a pending seeded row", async () => {
        await seedAnalysis(pool, "a-seeded", "pending");
        await setSeed(pool, "a-seeded", ["file-aaa", "file-bbb"]);

        const result = await triggerDataProfile(parkedDispatchDeps(pool), {
            auth: makeLocalAuth(),
            analysisId: "a-seeded",
            stagedInputs: [stagedInput("file-aaa")],
        });

        expect(result).toBe("started");
        expect(await rawStatus(pool, "a-seeded")).toBe("running");
        const status = (await loadDataProfileStatus(pool, "a-seeded"))._unsafeUnwrap();
        expect(status?.status).toBe("running");
    });

    it("re-claims a completed seeded row as a restart", async () => {
        await seedAnalysis(pool, "a-completed", "completed");
        await setSeed(pool, "a-completed", ["file-aaa"]);

        const result = await triggerDataProfile(parkedDispatchDeps(pool), {
            auth: makeLocalAuth(),
            analysisId: "a-completed",
            stagedInputs: [stagedInput("file-aaa")],
        });

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

        const result = await triggerDataProfile(tripwireDeps(pool), {
            auth: makeLocalAuth(),
            analysisId: "a-empty-manifest",
            stagedInputs: [],
        });

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
                ...pool,
                // Wipe the seed the instant the guard finishes reading it, before the CAS runs.
                query: async (...args: Parameters<Pool["query"]>) => {
                    const res = await pool.query(...args);
                    const text = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
                    if (text.includes("SELECT seed_input_file_ids")) await setSeed(pool, "a-raced", null);
                    return res;
                },
                // The spread above loses `Pool`'s prototype methods; only `query` is exercised
                // by `triggerDataProfile`, and it is replaced. The cast asserts exactly that.
            } as unknown as Pool,
        };

        const result = await triggerDataProfile(raced, {
            auth: makeLocalAuth(),
            analysisId: "a-raced",
            stagedInputs: [stagedInput("file-aaa")],
        });

        expect(result).toBe("failed");
        expect(await rawStatus(pool, "a-raced")).toBeNull();
    });
});

// The workflow body builds the completed profile's drift comparand from the staged
// manifest. A manifest recovered from before `StagedInput.mtimeMs` existed lacks that
// field, so the per-entry object would serialize to a shape that violates
// `DataProfileInputFile`; the signature is omitted whole, collapsing to drift. Pure —
// no DB, no container.
describe("buildDriftSignature — drift comparand for recovered legacy manifests", () => {
    it("builds a full signature when every entry carries mtimeMs", () => {
        const sig = buildDriftSignature([stagedInput("file-aaa"), stagedInput("file-bbb")]);
        expect(sig).toEqual([
            { fileId: "file-aaa", size: 1024, mtimeMs: 1_780_000_000_000 },
            { fileId: "file-bbb", size: 1024, mtimeMs: 1_780_000_000_000 },
        ]);
    });

    it("omits the whole signature when any entry lacks mtimeMs — a pre-deploy recovered input", () => {
        const sig = buildDriftSignature([stagedInput("file-aaa"), legacyStagedInput("file-legacy")]);
        expect(sig).toBeUndefined();
    });

    it("a built signature survives a JSON round-trip as a valid DataProfileInputFile[]", () => {
        // The value is persisted via JSON.stringify inside the `DataProfileResult`; confirm
        // no key drops out (the exact failure a legacy `mtimeMs: undefined` entry would cause).
        const sig = buildDriftSignature([stagedInput("file-aaa")]);
        expect(JSON.parse(JSON.stringify(sig))).toEqual([{ fileId: "file-aaa", size: 1024, mtimeMs: 1_780_000_000_000 }]);
    });
});
