import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";
import { z } from "zod";

import { withSchema } from "../../../__tests__/setup/postgres.js";
import type { AskRequest } from "../contract.js";
import { askPartOf, createAskGateway, type AskGateway, type AskScope } from "../gateway.js";
import { insertPendingAsk, type AskRow } from "../queries.js";
import { uuidv7 } from "../uuidv7.js";

const AskStateRowSchema = z.object({ status: z.string(), reply: z.json() });

const CountRowSchema = z.object({ n: z.number() });

// A fresh schema per test isolates the whole-ledger reads (`pending`,
// `sweepExpired`) so their assertions can be exact.
let pool: Pool;
let gateway: AskGateway;
let drop: () => Promise<void>;

beforeEach(async () => {
    const ctx = await withSchema("ask_gateway");
    pool = ctx.pool;
    drop = ctx.drop;
    gateway = createAskGateway({ pool });
});

afterEach(async () => {
    await drop();
});

const REQUEST: AskRequest = { title: "Run a command", command: "rm -rf /tmp/scratch", detail: "irreversible" };

// Two people in one analysis — the case an analysis-keyed grant used to conflate.
const USER_A = "user-A";
const USER_B = "user-B";

function scope(analysisId = "analysis-A", userId = USER_A): AskScope {
    return { analysisId, userId };
}

/** Raise an ask under a new id. */
async function raise(
    request: AskRequest,
    analysisId = "analysis-A",
    userId = USER_A,
): Promise<{ readonly id: string; readonly raised: "granted" | "pending" }> {
    const id = uuidv7();
    return { id, raised: await gateway.raise(id, request, scope(analysisId, userId)) };
}

async function selectRow(id: string): Promise<{ status: string; reply: unknown } | undefined> {
    const res = await pool.query({ text: `SELECT status, reply FROM cortex_asks WHERE id = $1`, values: [id] });
    const row: unknown = res.rows[0];
    return row === undefined ? undefined : AskStateRowSchema.parse(row);
}

async function countAsks(where = ""): Promise<number> {
    const res = await pool.query(`SELECT count(*)::int AS n FROM cortex_asks ${where}`);
    return CountRowSchema.parse(res.rows[0]).n;
}

describe("createAskGateway — the raise of a turn", () => {
    it("raises a pending ask under its id, and a second raise of the id changes nothing", async () => {
        const { id, raised } = await raise(REQUEST);

        expect(raised).toBe("pending");
        expect(await gateway.raise(id, { ...REQUEST, command: "a different command" }, scope())).toBe("pending");
        expect(await countAsks()).toBe(1);
        expect((await gateway.pending()).map((ask) => [ask.id, ask.command])).toEqual([[id, REQUEST.command]]);
    });

    it("records the once, the always, and the reject reply of an answer", async () => {
        for (const reply of [{ kind: "once" }, { kind: "always" }, { kind: "reject", feedback: "not this time" }] as const) {
            const { id } = await raise({ ...REQUEST, command: `command ${reply.kind}` });

            expect(await gateway.answer(id, reply)).toBe("applied");

            expect(await selectRow(id)).toEqual({ status: reply.kind === "reject" ? "rejected" : "resolved", reply });
        }
    });

    it("expires and aborts a pending ask, and an answer after that is already_terminal", async () => {
        const expired = await raise(REQUEST);
        const aborted = await raise({ ...REQUEST, command: "second command" });

        await gateway.expire(expired.id);
        await gateway.abort(aborted.id);

        expect((await selectRow(expired.id))?.status).toBe("expired");
        expect((await selectRow(aborted.id))?.status).toBe("aborted");
        expect(await gateway.answer(expired.id, { kind: "once" })).toBe("already_terminal");
        expect(await gateway.pending()).toHaveLength(0);
    });
});

describe("createAskGateway — answer and pending contract", () => {
    it("applies a pending answer, then reports already_terminal without overriding the row", async () => {
        const { id } = await raise(REQUEST);

        expect(await gateway.answer(id, { kind: "once" })).toBe("applied");
        // A second, differing answer on the same id is a reported no-op — never an override.
        expect(await gateway.answer(id, { kind: "reject", feedback: "too late" })).toBe("already_terminal");

        expect(await selectRow(id)).toEqual({ status: "resolved", reply: { kind: "once" } });
    });

    it("reports not_found for an unknown id and writes nothing", async () => {
        expect(await gateway.answer(uuidv7(), { kind: "once" })).toBe("not_found");
        expect(await countAsks()).toBe(0);
    });

    it("enumerates only unresolved asks", async () => {
        const answered = await raise(REQUEST, "analysis-A");
        expect(await gateway.answer(answered.id, { kind: "once" })).toBe("applied");
        const stillPending = await raise({ ...REQUEST, command: "second command" }, "analysis-B");

        expect((await gateway.pending()).map((a) => a.id)).toEqual([stillPending.id]);
    });

    it("reports the user each unresolved ask was raised for", async () => {
        const forA = await raise(REQUEST, "analysis-A", USER_A);
        const forB = await raise({ ...REQUEST, command: "second command" }, "analysis-B", USER_B);

        // A host reads this to route each ask to the person who can answer it.
        const userById = new Map((await gateway.pending()).map((ask) => [ask.id, ask.userId]));
        expect(userById.get(forA.id)).toBe(USER_A);
        expect(userById.get(forB.id)).toBe(USER_B);
    });
});

describe("createAskGateway — standing grants", () => {
    const GRANTED: AskRequest = { title: "Deploy", command: "git push --force", detail: undefined };

    async function grantCount(analysisId: string, grantKey: string, userId = USER_A): Promise<number> {
        const res = await pool.query({
            text: `SELECT count(*)::int AS n FROM cortex_ask_grants WHERE analysis_id = $1 AND grant_key = $2 AND user_id = $3`,
            values: [analysisId, grantKey, userId],
        });
        return CountRowSchema.parse(res.rows[0]).n;
    }

    /** Raise `request`, and answer it `always`. */
    async function grant(request: AskRequest, analysisId = "analysis-A", userId = USER_A): Promise<void> {
        const { id } = await raise(request, analysisId, userId);
        expect(await gateway.answer(id, { kind: "always" })).toBe("applied");
    }

    it("records a grant on always, then grants a matching raise at once and logs the audit row", async () => {
        await grant(GRANTED);

        expect(await grantCount("analysis-A", GRANTED.command)).toBe(1);
        const beforeResolved = await countAsks(`WHERE status = 'resolved'`);
        const { id, raised } = await raise(GRANTED);

        expect(raised).toBe("granted");
        expect(await gateway.pending()).toHaveLength(0);
        // The short-circuit still records a resolved audit row.
        expect(await selectRow(id)).toMatchObject({ status: "resolved" });
        expect(await countAsks(`WHERE status = 'resolved'`)).toBe(beforeResolved + 1);
    });

    it("keeps the grant across a simulated restart (fresh gateway, same pool)", async () => {
        await grant(GRANTED);

        const restarted = createAskGateway({ pool });

        expect(await restarted.raise(uuidv7(), GRANTED, scope())).toBe("granted");
        expect(await restarted.pending()).toHaveLength(0);
    });

    it("does not apply a grant across analyses", async () => {
        await grant(GRANTED, "analysis-A");

        // The same command in a different analysis pauses as if no grant existed.
        expect((await raise(GRANTED, "analysis-Z")).raised).toBe("pending");
    });

    it("does not apply the grant of one user to another user in the same analysis", async () => {
        await grant(GRANTED, "analysis-A", USER_A);

        expect(await grantCount("analysis-A", GRANTED.command, USER_A)).toBe(1);
        expect(await grantCount("analysis-A", GRANTED.command, USER_B)).toBe(0);
        // The same command in the same analysis, for a different person, pauses. This is the whole point of the user key.
        expect((await raise(GRANTED, "analysis-A", USER_B)).raised).toBe("pending");
    });

    it("records the grant under the user the ask was raised for", async () => {
        // `answer` takes no identity — the ledger row is what names the person, so a
        // decision recorded by anyone lands on the user of the paused turn.
        await grant(GRANTED, "analysis-A", USER_B);

        expect(await grantCount("analysis-A", GRANTED.command, USER_B)).toBe(1);
        expect(await grantCount("analysis-A", GRANTED.command, USER_A)).toBe(0);
        expect((await raise(GRANTED, "analysis-A", USER_B)).raised).toBe("granted");
    });

    // A grant key lets a tool bless a broader class than the one command it displays.
    const WIDE_KEY = "fs:write";
    const SHOWN: AskRequest = { title: "Write a file", command: "write_file report/a.txt", grantKey: WIDE_KEY };

    it("keys the grant on grantKey, granting a different command that shares it", async () => {
        await grant(SHOWN);

        // The grant lives under the grant key, not the displayed command.
        expect(await grantCount("analysis-A", WIDE_KEY)).toBe(1);
        expect(await grantCount("analysis-A", SHOWN.command)).toBe(0);
        const later: AskRequest = { title: "Write a file", command: "write_file report/b.txt", grantKey: WIDE_KEY };
        expect((await raise(later)).raised).toBe("granted");
        // The same grant key in a different analysis pauses as if no grant existed.
        expect((await raise(later, "analysis-Z")).raised).toBe("pending");
    });

    it("keys the grant on command when no grantKey is supplied, and never broader", async () => {
        await grant(GRANTED);

        expect(await grantCount("analysis-A", GRANTED.command)).toBe(1);
        // A different command in the same analysis is not covered — the grant is exactly the command.
        expect((await raise({ ...GRANTED, command: "git push origin main" })).raised).toBe("pending");
    });
});

describe("askPartOf", () => {
    it("shows the command and never the grant key, and only a terminal part names the reply", () => {
        const request: AskRequest = { title: "Write a file", command: "write_file report/a.txt", grantKey: "fs:write" };

        const pending = askPartOf("ask-1", request, "pending");
        const resolved = askPartOf("ask-1", request, "resolved", "once");

        expect(pending).toEqual({ type: "data-ask", id: "ask-1", title: request.title, command: request.command, status: "pending" });
        expect(resolved).toMatchObject({ id: "ask-1", status: "resolved", reply: "once" });
        expect(JSON.stringify([pending, resolved])).not.toContain("fs:write");
    });
});

// ── The boot sweep ────────────────────────────────────────────────────

describe("createAskGateway — sweep", () => {
    const STALE = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    function pendingRow(createdAt: string): AskRow {
        return { id: uuidv7(), analysisId: "analysis-A", userId: USER_A, threadId: null, title: "t", command: "c", detail: null, grantKey: null, createdAt };
    }

    it("expires orphaned pending rows past the max age and returns the count swept", async () => {
        const rows = [pendingRow(STALE), pendingRow(STALE)];
        for (const row of rows) {
            (await insertPendingAsk(pool, row))._unsafeUnwrap();
        }

        expect(await gateway.sweepExpired()).toBe(2);

        for (const row of rows) {
            expect((await selectRow(row.id))?.status).toBe("expired");
        }
        expect(await gateway.pending()).toHaveLength(0);
    });

    it("leaves a fresh pending ask untouched — a boot sweep cannot kill a live ask", async () => {
        const fresh = pendingRow(new Date().toISOString());
        (await insertPendingAsk(pool, fresh))._unsafeUnwrap();

        expect(await gateway.sweepExpired()).toBe(0);
        expect((await selectRow(fresh.id))?.status).toBe("pending");
        expect(await gateway.pending()).toHaveLength(1);
    });

    it("counts only the rows it swept when stale and fresh pend together", async () => {
        const stale = pendingRow(STALE);
        const fresh = pendingRow(new Date().toISOString());
        for (const row of [stale, fresh]) {
            (await insertPendingAsk(pool, row))._unsafeUnwrap();
        }

        expect(await gateway.sweepExpired()).toBe(1);
        expect((await selectRow(stale.id))?.status).toBe("expired");
        expect((await selectRow(fresh.id))?.status).toBe("pending");
    });

    it("honors an explicit maxAgeMs", async () => {
        const row = pendingRow(new Date(Date.now() - 60_000).toISOString());
        (await insertPendingAsk(pool, row))._unsafeUnwrap();

        expect(await gateway.sweepExpired(30_000)).toBe(1);
        expect((await selectRow(row.id))?.status).toBe("expired");
    });
});
