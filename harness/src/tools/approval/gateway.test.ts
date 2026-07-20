import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../../__tests__/setup/postgres.js";
import type { ChatDataPart, EmitFn } from "../../loop/types.js";
import { AskRejectedError, type AskRequest } from "./contract.js";
import { createAskGateway, type AskContext, type AskGateway } from "./gateway.js";
import { insertPendingAsk, type AskRow } from "./queries.js";
import { uuidv7 } from "./uuidv7.js";

// The `data-ask` payload the gateway emits inside a `ChatDataPart` — the flat
// fields without the part-envelope `type`, as a surface would read them.
interface AskPartData {
    readonly id: string;
    readonly title: string;
    readonly command: string;
    readonly detail?: string;
    readonly status: string;
}

interface StartedAsk {
    readonly promise: Promise<{ kind: "once" | "always" }>;
    readonly parts: AskPartData[];
    readonly controller: AbortController;
}

// A fresh schema per test isolates the whole-ledger reads (`pending`,
// `sweepExpired`) so their assertions can be exact.
let pool: Pool;
let gateway: AskGateway;
let drop: () => Promise<void>;

// Every ask started but not explicitly settled is torn down here, so a dropped
// pool never races an in-flight poll into an unhandled rejection.
let controllers: AbortController[];
let settled: Promise<unknown>[];

beforeEach(async () => {
    const ctx = await withSchema("ask_gateway");
    pool = ctx.pool;
    drop = ctx.drop;
    gateway = createAskGateway({ pool });
    controllers = [];
    settled = [];
});

afterEach(async () => {
    for (const c of controllers) c.abort();
    await Promise.allSettled(settled);
    await drop();
});

const REQUEST: AskRequest = { title: "Run a command", command: "rm -rf /tmp/scratch", detail: "irreversible" };

/** Start `ask` without awaiting, collecting its emitted `data-ask` parts. */
function startAsk(request: AskRequest, analysisId = "analysis-A"): StartedAsk {
    const controller = new AbortController();
    const parts: AskPartData[] = [];
    const emit: EmitFn = (event) => {
        if (event.type === "data-ask") parts.push((event as ChatDataPart).data as AskPartData);
    };
    const ctx: AskContext = { analysisId, signal: controller.signal, emit };
    const promise = gateway.ask(request, ctx);
    controllers.push(controller);
    // A swallowing copy so a rejection the test itself awaits is not also seen as
    // unhandled during teardown.
    settled.push(promise.catch(() => {}));
    return { promise, parts, controller };
}

/** Poll the ledger until a pending ask (optionally for one analysis) appears; return its id. */
async function waitForPendingId(analysisId?: string): Promise<string> {
    const deadline = Date.now() + 5000;
    for (;;) {
        const asks = await gateway.pending();
        const match = analysisId === undefined ? asks : asks.filter((a) => a.analysisId === analysisId);
        const latest = match.at(-1);
        if (latest !== undefined) return latest.id;
        if (Date.now() > deadline) throw new Error("timed out waiting for a pending ask");
        await new Promise((r) => setTimeout(r, 15));
    }
}

async function selectRow(id: string): Promise<{ status: string; reply: unknown } | undefined> {
    const res = await pool.query({ text: `SELECT status, reply FROM cortex_asks WHERE id = $1`, values: [id] });
    return res.rows[0] as { status: string; reply: unknown } | undefined;
}

async function countAsks(where = ""): Promise<number> {
    const res = await pool.query(`SELECT count(*)::int AS n FROM cortex_asks ${where}`);
    return (res.rows[0] as { n: number }).n;
}

// ── 5.1 — deferred round-trip, one case per reply variant ────────────

describe("createAskGateway — deferred round-trip", () => {
    it("resolves a suspended ask with the once reply an out-of-band answer writes", async () => {
        const started = startAsk(REQUEST);
        const id = await waitForPendingId();

        expect(await gateway.answer(id, { kind: "once" })).toBe("applied");

        expect(await started.promise).toEqual({ kind: "once" });
        // The part is emitted pending, then reconciled to its terminal status under
        // the same id — the out-of-band path a surface renders and folds latest-wins.
        expect(started.parts.map((p) => p.status)).toEqual(["pending", "resolved"]);
        expect(started.parts.map((p) => p.id)).toEqual([id, id]);
        expect(started.parts[0]!.command).toBe(REQUEST.command);
    });

    it("resolves with the always reply an out-of-band answer writes", async () => {
        const started = startAsk(REQUEST);
        const id = await waitForPendingId();

        expect(await gateway.answer(id, { kind: "always" })).toBe("applied");

        expect(await started.promise).toEqual({ kind: "always" });
    });

    it("throws AskRejectedError carrying the feedback when the answer rejects", async () => {
        const started = startAsk(REQUEST);
        const id = await waitForPendingId();

        expect(await gateway.answer(id, { kind: "reject", feedback: "not this time" })).toBe("applied");

        const caught = await started.promise.then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(caught).toBeInstanceOf(AskRejectedError);
        expect((caught as AskRejectedError).feedback).toBe("not this time");
    });
});

// ── 5.2 — the answer / pending ledger contract ───────────────────────

describe("createAskGateway — answer and pending contract", () => {
    it("applies a pending answer, then reports already_terminal without overriding the row", async () => {
        const started = startAsk(REQUEST);
        const id = await waitForPendingId();

        expect(await gateway.answer(id, { kind: "once" })).toBe("applied");
        expect(await started.promise).toEqual({ kind: "once" });

        // A second, differing answer on the same id is a reported no-op — never an
        // override.
        expect(await gateway.answer(id, { kind: "reject", feedback: "too late" })).toBe("already_terminal");

        const row = await selectRow(id);
        expect(row?.status).toBe("resolved");
        expect(row?.reply).toEqual({ kind: "once" });
    });

    it("reports not_found for an unknown id and writes nothing", async () => {
        expect(await gateway.answer(uuidv7(), { kind: "once" })).toBe("not_found");
        expect(await countAsks()).toBe(0);
    });

    it("enumerates only unresolved asks", async () => {
        const answered = startAsk(REQUEST, "analysis-A");
        const idAnswered = await waitForPendingId("analysis-A");
        expect(await gateway.answer(idAnswered, { kind: "once" })).toBe("applied");
        await answered.promise;

        const stillPending = startAsk({ ...REQUEST, command: "second command" }, "analysis-B");
        const idPending = await waitForPendingId("analysis-B");

        const enumerated = await gateway.pending();
        expect(enumerated.map((a) => a.id)).toEqual([idPending]);

        // Settle the survivor so teardown has nothing racing the drop.
        expect(await gateway.answer(idPending, { kind: "once" })).toBe("applied");
        expect(await stillPending.promise).toEqual({ kind: "once" });
    });
});

// ── 5.3 — analysis-scoped standing grants ────────────────────────────

describe("createAskGateway — standing grants", () => {
    const GRANTED: AskRequest = { title: "Deploy", command: "git push --force", detail: undefined };

    async function grantCount(analysisId: string, grantKey: string): Promise<number> {
        const res = await pool.query({
            text: `SELECT count(*)::int AS n FROM cortex_ask_grants WHERE analysis_id = $1 AND grant_key = $2`,
            values: [analysisId, grantKey],
        });
        return (res.rows[0] as { n: number }).n;
    }

    it("records a grant on always, then auto-approves a matching ask without pausing and logs the audit row", async () => {
        const first = startAsk(GRANTED, "analysis-A");
        const id = await waitForPendingId("analysis-A");
        expect(await gateway.answer(id, { kind: "always" })).toBe("applied");
        expect(await first.promise).toEqual({ kind: "always" });

        expect(await grantCount("analysis-A", GRANTED.command)).toBe(1);

        // The matching ask returns fast and never surfaces a prompt.
        const beforeResolved = await countAsks(`WHERE status = 'resolved'`);
        const controller = new AbortController();
        const parts: AskPartData[] = [];
        const emit: EmitFn = (event) => {
            if (event.type === "data-ask") parts.push((event as ChatDataPart).data as AskPartData);
        };
        const reply = await gateway.ask(GRANTED, { analysisId: "analysis-A", signal: controller.signal, emit });

        expect(reply).toEqual({ kind: "always" });
        expect(parts).toHaveLength(0);
        expect(await gateway.pending()).toHaveLength(0);
        // The short-circuit still records a resolved audit row.
        expect(await countAsks(`WHERE status = 'resolved'`)).toBe(beforeResolved + 1);
    });

    it("keeps the grant across a simulated restart (fresh gateway, same pool)", async () => {
        const first = startAsk(GRANTED, "analysis-A");
        const id = await waitForPendingId("analysis-A");
        expect(await gateway.answer(id, { kind: "always" })).toBe("applied");
        expect(await first.promise).toEqual({ kind: "always" });

        const restarted = createAskGateway({ pool });
        const controller = new AbortController();
        const reply = await restarted.ask(GRANTED, { analysisId: "analysis-A", signal: controller.signal, emit: () => {} });

        expect(reply).toEqual({ kind: "always" });
        expect(await restarted.pending()).toHaveLength(0);
    });

    it("does not apply a grant across analyses", async () => {
        const first = startAsk(GRANTED, "analysis-A");
        const id = await waitForPendingId("analysis-A");
        expect(await gateway.answer(id, { kind: "always" })).toBe("applied");
        expect(await first.promise).toEqual({ kind: "always" });

        // The same command in a different analysis pauses as if no grant existed.
        const other = startAsk(GRANTED, "analysis-Z");
        const otherId = await waitForPendingId("analysis-Z");
        expect(otherId).toBeString();

        expect(await gateway.answer(otherId, { kind: "once" })).toBe("applied");
        expect(await other.promise).toEqual({ kind: "once" });
    });

    // A grant key lets a tool bless a broader class than the one command it displays.
    const WIDE_KEY = "fs:write";
    const SHOWN: AskRequest = { title: "Write a file", command: "write_file report/a.txt", grantKey: WIDE_KEY };

    it("keys the grant on grantKey, auto-approving a different command that shares it", async () => {
        const first = startAsk(SHOWN, "analysis-A");
        const id = await waitForPendingId("analysis-A");
        expect(await gateway.answer(id, { kind: "always" })).toBe("applied");
        expect(await first.promise).toEqual({ kind: "always" });

        // The grant lives under the grant key, not the displayed command.
        expect(await grantCount("analysis-A", WIDE_KEY)).toBe(1);
        expect(await grantCount("analysis-A", SHOWN.command)).toBe(0);

        // A later ask with a DIFFERENT command but the SAME grant key short-circuits:
        // no prompt surfaces and a resolved audit row is still written.
        const beforeResolved = await countAsks(`WHERE status = 'resolved'`);
        const parts: AskPartData[] = [];
        const emit: EmitFn = (event) => {
            if (event.type === "data-ask") parts.push((event as ChatDataPart).data as AskPartData);
        };
        const later: AskRequest = { title: "Write a file", command: "write_file report/b.txt", grantKey: WIDE_KEY };
        const reply = await gateway.ask(later, { analysisId: "analysis-A", signal: new AbortController().signal, emit });

        expect(reply).toEqual({ kind: "always" });
        expect(parts).toHaveLength(0);
        expect(await gateway.pending()).toHaveLength(0);
        expect(await countAsks(`WHERE status = 'resolved'`)).toBe(beforeResolved + 1);

        // The same grant key in a different analysis pauses as if no grant existed.
        const crossed = startAsk(later, "analysis-Z");
        const crossedId = await waitForPendingId("analysis-Z");
        expect(await gateway.answer(crossedId, { kind: "once" })).toBe("applied");
        expect(await crossed.promise).toEqual({ kind: "once" });
    });

    it("keys the grant on command when no grantKey is supplied, and never broader", async () => {
        // GRANTED carries no grantKey — the pre-grantKey behavior.
        const first = startAsk(GRANTED, "analysis-A");
        const id = await waitForPendingId("analysis-A");
        expect(await gateway.answer(id, { kind: "always" })).toBe("applied");
        expect(await first.promise).toEqual({ kind: "always" });

        // The grant keys on the command itself.
        expect(await grantCount("analysis-A", GRANTED.command)).toBe(1);

        // A different command in the same analysis is not covered — the grant is
        // exactly the command, nothing broader — so it pauses for its own decision.
        const other = startAsk({ ...GRANTED, command: "git push origin main" }, "analysis-A");
        const otherId = await waitForPendingId("analysis-A");
        expect(await gateway.answer(otherId, { kind: "once" })).toBe("applied");
        expect(await other.promise).toEqual({ kind: "once" });
    });

    it("emits the command in the data-ask part and never the grant key", async () => {
        const started = startAsk(SHOWN, "analysis-A");
        const id = await waitForPendingId("analysis-A");
        // Settle so teardown never races the drop.
        expect(await gateway.answer(id, { kind: "once" })).toBe("applied");
        await started.promise;

        expect(started.parts.length).toBeGreaterThan(0);
        for (const part of started.parts) {
            expect(part.command).toBe(SHOWN.command);
            expect(part).not.toHaveProperty("grantKey");
            expect(JSON.stringify(part)).not.toContain(WIDE_KEY);
        }
    });
});

// ── 5.4 — turn abort ─────────────────────────────────────────────────

describe("createAskGateway — abort", () => {
    it("marks the row aborted and re-throws the cancellation, not AskRejectedError", async () => {
        const started = startAsk(REQUEST);
        const id = await waitForPendingId();

        const reason = new Error("turn cancelled");
        started.controller.abort(reason);

        const caught = await started.promise.then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(caught).toBe(reason);
        expect(caught).not.toBeInstanceOf(AskRejectedError);

        const row = await selectRow(id);
        expect(row?.status).toBe("aborted");
    });
});

// ── 5.5 — boot sweep ─────────────────────────────────────────────────

describe("createAskGateway — sweep", () => {
    it("expires orphaned pending rows and returns the count swept", async () => {
        const now = new Date().toISOString();
        const rows: AskRow[] = [
            { id: uuidv7(), analysisId: "analysis-A", threadId: null, title: "t1", command: "c1", detail: null, grantKey: null, createdAt: now },
            { id: uuidv7(), analysisId: "analysis-A", threadId: null, title: "t2", command: "c2", detail: null, grantKey: null, createdAt: now },
        ];
        for (const row of rows) {
            (await insertPendingAsk(pool, row))._unsafeUnwrap();
        }

        expect(await gateway.sweepExpired()).toBe(2);

        for (const row of rows) {
            expect((await selectRow(row.id))?.status).toBe("expired");
        }
        expect(await gateway.pending()).toHaveLength(0);
    });
});
