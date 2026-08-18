import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ResultAsync } from "neverthrow";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import type { Scope } from "../auth/types.js";
import { createReportSessionSpawn } from "../app/spawn-report-session.js";
import type { DbError } from "../lib/db-result.js";
import type { AcquireEyes } from "../lib/eyes.js";
import { conversationRecordTurn, createThreadHistory } from "../memory/thread-history.js";
import { createThreadStore, type ThreadStore } from "../memory/thread-store.js";
import { makeToolContext } from "./__fixtures__/tool-context.js";
import type { Tool, ToolContext } from "./define-tool.js";
import { createStartReportSessionTool, type StartReportSessionInput, type StartReportSessionResult } from "./start-report-session.js";

const ANALYSIS = "analysis-a";

/** A chrome config that names a browser. The tool never connects, thus the eyes gate passes with no sidecar. */
const WITH_BROWSER = { browserUrl: "http://localhost:9222" };

/** A bound eyes seam. The tool hands it to the spawn, thus no lease of it ever opens. */
const EYES_SEAM: AcquireEyes = () => Promise.resolve({ browserUrl: WITH_BROWSER.browserUrl, release: () => Promise.resolve() });

/** The brief of one call. Each field is present, thus the seed of the child shows each label. */
const INPUT: StartReportSessionInput = {
    objective: "Explain the sample quality outcome",
    audience: "The lab lead",
    angle: "The samples that the study keeps",
    exclusions: "The raw alignment logs",
    openQuestions: "The threshold of the batch correction",
};

let pool: Pool;
let drop: () => Promise<void>;
let store: ThreadStore;
let tool: Tool<StartReportSessionInput, StartReportSessionResult>;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("start-report-session"));
    store = createThreadStore(pool);
    tool = createStartReportSessionTool({ pool, chrome: WITH_BROWSER });
});

afterEach(async () => {
    await drop();
});

// --- seeding ----------------------------------------------------------------

/** Persist one two-message turn on a thread, giving it a transcript to anchor into. */
function appendTurn(threadId: string): ResultAsync<void, DbError> {
    return createThreadHistory(pool).appendTurn(threadId, {
        modelMessages: [
            { role: "user", content: [{ type: "text", text: "hi" }] },
            { role: "assistant", content: [{ type: "text", text: "hello" }] },
        ],
        displayMessages: [],
    });
}

/** Append one record of out-of-band work — a synthetic message that opens no turn. */
function appendRecord(threadId: string, text: string): ResultAsync<void, DbError> {
    return createThreadHistory(pool).appendTurn(threadId, conversationRecordTurn(text));
}

/** A live conversation parent with a first turn — the shape a legal start needs. */
async function seedConversation(threadId: string, title: string | null): Promise<void> {
    (await store.createThread({ threadId, analysisId: ANALYSIS, ...(title === null ? {} : { title }) }))._unsafeUnwrap();
    (await appendTurn(threadId))._unsafeUnwrap();
}

/** A tool context whose scope names one conversation thread of the analysis. */
function ctxForThread(threadId: string): ToolContext {
    const { ctx } = makeToolContext();
    const scope: Scope = { kind: "analysis", analysisId: ANALYSIS, threadId };
    return { ...ctx, session: { ...ctx.session, scope } };
}

/** The count of `report` rows in the schema — 0 says that a refusal wrote nothing. */
async function reportThreadCount(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM cortex_analysis_threads WHERE thread_type = 'report'");
    return Number(rows[0]!.count);
}

/**
 * Make each later insert into `messages` fail. The trigger is real database
 * state, thus the seed write of the spawn fails the same way that a driver fault
 * fails it. A delete stays permitted, thus the purge of the child still runs.
 */
async function refuseMessageInserts(): Promise<void> {
    await pool.query("CREATE FUNCTION refuse_message_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'seed write refused'; END; $$");
    await pool.query("CREATE TRIGGER refuse_message_insert BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION refuse_message_insert()");
}

/**
 * A pool that forwards each statement to the real one and records its text. The
 * advice of the tool costs two reads, thus an empty record says that the closed
 * gate skipped them.
 *
 * The cast names the whole surface that the spawn reads: `query` for each read
 * and each insert, and `connect` for the transaction of the seed write. Thus the
 * two members carry every call that a case makes.
 */
function watchedPool(): { watched: Pool; statements: string[] } {
    const statements: string[] = [];
    const forward = pool.query.bind(pool) as unknown as (text: unknown, values?: unknown) => Promise<unknown>;
    const query = (text: unknown, values?: unknown): Promise<unknown> => {
        statements.push(typeof text === "string" ? text : JSON.stringify(text));
        return forward(text, values);
    };
    return { watched: { query, connect: () => pool.connect() } as unknown as Pool, statements };
}

/** Run the tool and unwrap the ok channel, which each degraded condition also rides. */
async function run(input: StartReportSessionInput, ctx: ToolContext): Promise<StartReportSessionResult> {
    return (await tool.execute(input, ctx))._unsafeUnwrap();
}

describe("the started arm", () => {
    it("starts a child session and gives its thread id and its title", async () => {
        await seedConversation("p1", "RNA-seq QC");

        const result = await run(INPUT, ctxForThread("p1"));

        expect(result.outcome).toBe("started");
        if (result.outcome !== "started") return;
        expect(result.title).toBe("RNA-seq QC — Report 1");
        // The row is on disk, not only in the returned value.
        const child = (await store.getThread(result.threadId))._unsafeUnwrap();
        expect(child!.threadType).toBe("report");
        expect(child!.parentThreadId).toBe("p1");
        expect(await reportThreadCount()).toBe(1);
    });

    it("starts a session for a parent that holds no report child", async () => {
        await seedConversation("p1", "Parent");
        // The brief carries the two optional fields as absent, thus the input with
        // three fields alone also starts a session.
        const brief: StartReportSessionInput = { objective: INPUT.objective, audience: INPUT.audience, angle: INPUT.angle };

        const result = await run(brief, ctxForThread("p1"));

        expect(result.outcome).toBe("started");
        expect(await reportThreadCount()).toBe(1);
    });
});

describe("the started part", () => {
    /** A tool context for one conversation thread, plus the record of its emitted events. */
    function watchedCtxForThread(threadId: string): { ctx: ToolContext; emitted: unknown[] } {
        const { ctx, emitted } = makeToolContext();
        const scope: Scope = { kind: "analysis", analysisId: ANALYSIS, threadId };
        return { ctx: { ...ctx, session: { ...ctx.session, scope } }, emitted };
    }

    it("emits one data-child-session-started part on the started arm", async () => {
        await seedConversation("p1", "Parent");
        const { ctx, emitted } = watchedCtxForThread("p1");

        const result = (await tool.execute(INPUT, ctx))._unsafeUnwrap();

        expect(result.outcome).toBe("started");
        if (result.outcome !== "started") return;
        expect(emitted).toEqual([{ type: "data-child-session-started", data: { threadId: result.threadId, parentThreadId: "p1", threadType: "report" } }]);
    });

    it("emits nothing on the existing-session arm", async () => {
        await seedConversation("p1", "Parent");
        expect((await run(INPUT, ctxForThread("p1"))).outcome).toBe("started");
        const { ctx, emitted } = watchedCtxForThread("p1");

        const result = (await tool.execute(INPUT, ctx))._unsafeUnwrap();

        // The arm names a session that an earlier turn announced, thus a second
        // part would put a second entry into the transcript.
        expect(result.outcome).toBe("existing-session");
        expect(emitted).toEqual([]);
    });

    it("emits nothing on a refusal", async () => {
        const { ctx, emitted } = watchedCtxForThread("ghost");

        const result = (await tool.execute(INPUT, ctx))._unsafeUnwrap();

        expect(result.outcome).toBe("parent_not_found");
        expect(emitted).toEqual([]);
    });
});

describe("the refused arm", () => {
    it("refuses a scope that carries no thread id, and writes no row", async () => {
        await seedConversation("p1", "Parent");
        const { ctx } = makeToolContext();

        const result = await run(INPUT, { ...ctx, session: { ...ctx.session, scope: { kind: "analysis", analysisId: ANALYSIS } } });

        expect(result.outcome).toBe("refused");
        if (result.outcome !== "refused") return;
        expect(result.detail.length).toBeGreaterThan(0);
        expect(await reportThreadCount()).toBe(0);
    });

    it("refuses a scope of a different kind, and writes no row", async () => {
        const { ctx } = makeToolContext();
        const scope: Scope = { kind: "target-assessment", targetAssessmentId: "ta-1", billingContextId: "b-1" };

        const result = await run(INPUT, { ...ctx, session: { ...ctx.session, scope } });

        expect(result.outcome).toBe("refused");
        expect(await reportThreadCount()).toBe(0);
    });
});

describe("the eyes gate", () => {
    it("gives the no_browser arm with the detail of the spawn, and writes no row", async () => {
        await seedConversation("p1", "Parent");
        const blind = createStartReportSessionTool({ pool, chrome: {} });
        // The detail comes from the spawn, thus the test reads the one line from
        // there and no literal drifts between the two modules.
        const refusal = (await createReportSessionSpawn({ pool, chrome: {} }).spawnReportSession("p1", INPUT))._unsafeUnwrapErr();

        const result = (await blind.execute(INPUT, ctxForThread("p1")))._unsafeUnwrap();

        expect(result.outcome).toBe("no_browser");
        if (result.outcome !== "no_browser") return;
        expect(refusal.type).toBe("no_browser");
        expect(result.detail).toBe(refusal.type === "no_browser" ? refusal.detail : "");
        expect(await reportThreadCount()).toBe(0);
    });

    it("starts a session when the composition binds the seam and names no browser", async () => {
        await seedConversation("p1", "Parent");
        const { watched, statements } = watchedPool();
        const seeing = createStartReportSessionTool({ pool: watched, chrome: {}, eyes: EYES_SEAM });

        const result = (await seeing.execute(INPUT, ctxForThread("p1")))._unsafeUnwrap();

        expect(result.outcome).toBe("started");
        // The count over the `report` rows finds the child. Thus the seam opened
        // the gate of the tool and the gate of the spawn.
        expect(await reportThreadCount()).toBe(1);
        // The open gate runs the advice. Thus this record is the positive control
        // of the empty record in the case below.
        expect(statements.length).toBeGreaterThan(0);
    });

    it("runs no advice read under a composition with no route", async () => {
        await seedConversation("p1", "Parent");
        const { watched, statements } = watchedPool();
        const blind = createStartReportSessionTool({ pool: watched, chrome: {} });

        const result = (await blind.execute(INPUT, ctxForThread("p1")))._unsafeUnwrap();

        expect(result.outcome).toBe("no_browser");
        // The gate of the tool exists to skip the two reads of the advice. The
        // spawn refuses before its own reads, thus the whole call sends no
        // statement at all.
        expect(statements).toEqual([]);
        expect(await reportThreadCount()).toBe(0);
    });

    it("has priority over the advice: an advised parent under a blind composition gives no_browser", async () => {
        await seedConversation("p1", "Parent");
        // The one child sits at the end of the parent transcript, thus no user
        // turn follows the anchor and the advice would return, if the gate ran second.
        const started = await run(INPUT, ctxForThread("p1"));
        expect(started.outcome).toBe("started");
        const blind = createStartReportSessionTool({ pool, chrome: {} });

        const result = (await blind.execute(INPUT, ctxForThread("p1")))._unsafeUnwrap();

        expect(result.outcome).toBe("no_browser");
        expect(await reportThreadCount()).toBe(1);
    });
});

describe("the existing-session arm", () => {
    it("names the newest child when no user turn follows the anchor, and starts no second session", async () => {
        await seedConversation("p1", "Parent");
        const started = await run(INPUT, ctxForThread("p1"));
        expect(started.outcome).toBe("started");
        if (started.outcome !== "started") return;

        const result = await run(INPUT, ctxForThread("p1"));

        expect(result.outcome).toBe("existing-session");
        if (result.outcome !== "existing-session") return;
        expect(result.threadId).toBe(started.threadId);
        expect(result.title).toBe(started.title);
        expect(await reportThreadCount()).toBe(1);
    });

    it("keeps the advice when the turn of the ask that started the session lands past the anchor", async () => {
        await seedConversation("p1", "Parent");
        const started = await run(INPUT, ctxForThread("p1"));
        expect(started.outcome).toBe("started");
        if (started.outcome !== "started") return;
        // The caller appends the whole turn after the loop of that turn runs, thus
        // the ask that started the session lands one user turn past the anchor.
        (await appendTurn("p1"))._unsafeUnwrap();

        const result = await run(INPUT, ctxForThread("p1"));

        expect(result.outcome).toBe("existing-session");
        if (result.outcome !== "existing-session") return;
        expect(result.threadId).toBe(started.threadId);
        expect(await reportThreadCount()).toBe(1);
    });

    it("keeps the advice when a record of the host lands past the anchor", async () => {
        await seedConversation("p1", "Parent");
        expect((await run(INPUT, ctxForThread("p1"))).outcome).toBe("started");
        // The turn of the ask, and then one record of out-of-band work. A record
        // opens no turn, thus it never clears the advice on its own.
        (await appendTurn("p1"))._unsafeUnwrap();
        (await appendRecord("p1", "Run GSEA cross-species comparison completed: 3/3 steps."))._unsafeUnwrap();

        const result = await run(INPUT, ctxForThread("p1"));

        expect(result.outcome).toBe("existing-session");
        expect(await reportThreadCount()).toBe(1);
    });

    it("starts a session again after a second user turn on the parent", async () => {
        await seedConversation("p1", "Parent");
        expect((await run(INPUT, ctxForThread("p1"))).outcome).toBe("started");
        // The turn of the ask, and then one turn of real work past the anchor.
        (await appendTurn("p1"))._unsafeUnwrap();
        (await appendTurn("p1"))._unsafeUnwrap();

        const result = await run(INPUT, ctxForThread("p1"));

        expect(result.outcome).toBe("started");
        expect(await reportThreadCount()).toBe(2);
    });
});

describe("the override", () => {
    it("starts a second session on an advised parent when newSessionAnyway is true", async () => {
        await seedConversation("p1", "Parent");
        const started = await run(INPUT, ctxForThread("p1"));
        expect(started.outcome).toBe("started");

        const result = await run({ ...INPUT, newSessionAnyway: true }, ctxForThread("p1"));

        expect(result.outcome).toBe("started");
        if (result.outcome !== "started") return;
        expect(result.title).toBe("Parent — Report 2");
        expect(await reportThreadCount()).toBe(2);
    });

    it("keeps the advice when newSessionAnyway is false", async () => {
        await seedConversation("p1", "Parent");
        expect((await run(INPUT, ctxForThread("p1"))).outcome).toBe("started");

        const result = await run({ ...INPUT, newSessionAnyway: false }, ctxForThread("p1"));

        expect(result.outcome).toBe("existing-session");
        expect(await reportThreadCount()).toBe(1);
    });
});

describe("the refusals of the spawn", () => {
    it("passes parent_not_found through, and writes no row", async () => {
        const result = await run(INPUT, ctxForThread("ghost"));

        expect(result.outcome).toBe("parent_not_found");
        expect(await reportThreadCount()).toBe(0);
    });

    it("passes parent_not_a_conversation through, and names the type of the thread", async () => {
        (await store.createThread({ threadId: "r1", analysisId: ANALYSIS, title: "A report", type: "report" }))._unsafeUnwrap();

        const result = await run(INPUT, ctxForThread("r1"));

        expect(result.outcome).toBe("parent_not_a_conversation");
        if (result.outcome !== "parent_not_a_conversation") return;
        expect(result.threadType).toBe("report");
        // Only the seed report exists — the tool added none.
        expect(await reportThreadCount()).toBe(1);
    });

    it("passes empty_parent_transcript through, and writes no row", async () => {
        (await store.createThread({ threadId: "p1", analysisId: ANALYSIS, title: "Empty" }))._unsafeUnwrap();

        const result = await run(INPUT, ctxForThread("p1"));

        expect(result.outcome).toBe("empty_parent_transcript");
        expect(await reportThreadCount()).toBe(0);
    });
});

describe("the bounds of the brief", () => {
    it("refuses a field past its bound, and accepts the same field at the bound", async () => {
        // The bound of `audience` is the smallest of the five, thus one long value
        // shows the rule with no dependence on the number itself.
        const atBound = { ...INPUT, audience: "x".repeat(200) };
        const pastBound = { ...INPUT, audience: "x".repeat(201) };

        expect(tool.inputSchema.safeParse(atBound).success).toBe(true);
        expect(tool.inputSchema.safeParse(pastBound).success).toBe(false);
        // The bound is a schema rule, thus the registry refuses the call before the
        // brief can reach the durable message row.
        expect(await reportThreadCount()).toBe(0);
    });
});

describe("the failed arm", () => {
    it("gives a short detail when the seed write fails, and no child survives", async () => {
        await seedConversation("p1", "Parent");
        // The parent transcript is complete before the refusal, thus only the seed
        // write of the spawn fails, and it fails after the thread insert.
        await refuseMessageInserts();

        const result = await run(INPUT, ctxForThread("p1"));

        expect(result.outcome).toBe("failed");
        if (result.outcome !== "failed") return;
        expect(result.detail).toContain("database write failed");
        expect(await reportThreadCount()).toBe(0);
    });
});
