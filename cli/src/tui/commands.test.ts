import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { err, errAsync, ok, okAsync } from "neverthrow";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportSessionDir } from "@inflexa-ai/harness";
import type { AnalysisPurgeOutcome, DbError, Pool, Thread, ThreadPage } from "@inflexa-ai/harness";

import { GLYPHS } from "../lib/design_system.ts";
import { __setAgentModelsForTest, __setBootStateForTest } from "./hooks/boot.ts";
import { __resetNoticesForTest, currentNotice } from "./hooks/notice.ts";
import {
    commands,
    commitSessionRename,
    commitSessionRestore,
    confirmSessionDelete,
    confirmSessionPurge,
    deleteAnalysisWith,
    deleteSessionFlow,
    exportProvenanceToFile,
    modelStatusLines,
    newSessionFlow,
    openAnalysis,
    openRenameSession,
    openRestoreSession,
    openSwitchSession,
    purgeSessionFlow,
    realSessionSeams,
    selectSwitchSession,
    switchSessionItems,
    type AnalysisDeleteSeams,
    type CommandId,
    type ProvExportSeams,
    type SessionSeams,
} from "./commands.tsx";
import type { Workspace } from "./contexts/workspace.ts";
import type { Notice } from "./theme.ts";
import type { HarnessRuntime } from "../modules/harness/runtime.ts";
import type { WorkspaceDisposal, WorkspaceError } from "../modules/analysis/output.ts";
import type { ProvAttestation, ProvSigningError as SigningError } from "@inflexa-ai/prov-kernel";
// The SQLite layer's error union, distinct from the harness's Postgres one already imported above.
import type { DbError as SqliteError } from "../db/errors.ts";
import type { Analysis } from "../types/analysis.ts";

// modelStatusLines reads the module-level boot + agentModels stores, so each test seeds them via the
// test hooks and the reset below keeps one test's seed from bleeding into the next (the same pairing
// sidebar.render.test.tsx uses for the rail's MODELS section).
afterEach(() => {
    __setAgentModelsForTest({ current: { conversation: "", sandbox: "", utility: "" }, pending: new Map() });
    __setBootStateForTest({ phase: "idle" });
});

describe("modelStatusLines", () => {
    test("before boot reaches ready it mirrors the rail's placeholder", () => {
        expect(modelStatusLines()).toEqual(["models: runtime not ready"]);
    });

    test("a failed boot surfaces its actionable message", () => {
        __setBootStateForTest({ phase: "failed", message: "proxy unreachable — run inflexa up" });
        const [line] = modelStatusLines();
        expect(line).toContain("boot failed");
        expect(line).toContain("proxy unreachable — run inflexa up");
    });

    test("ready: spells out the cliproxy connection and each agent's live model", () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        __setAgentModelsForTest({
            current: { conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5", utility: "claude-sonnet-4-5" },
            pending: new Map(),
        });
        const lines = modelStatusLines();
        expect(lines[0]).toContain("anthropic");
        expect(lines[0]).toContain("cliproxy (managed local proxy)");
        expect(lines[1]).toBe("chat model: claude-opus-4-8");
        expect(lines[2]).toBe("sandbox model: claude-sonnet-4-5");
    });

    test("ready: a direct connection glosses the user-configured endpoint", () => {
        __setBootStateForTest({ phase: "ready", model: "deepseek-chat", connection: { provider: "deepseek", mode: "direct" } });
        __setAgentModelsForTest({ current: { conversation: "deepseek-chat", sandbox: "deepseek-reasoner", utility: "deepseek-reasoner" }, pending: new Map() });
        expect(modelStatusLines()[0]).toContain("direct (user-configured endpoint)");
    });

    test("a scheduled switch renders as current → pending on the agent's line", () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        __setAgentModelsForTest({
            current: { conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5", utility: "claude-sonnet-4-5" },
            pending: new Map([["sandbox", "claude-haiku-4-5"]]),
        });
        expect(modelStatusLines()[2]).toContain(`claude-sonnet-4-5 ${GLYPHS.arrowRight} claude-haiku-4-5 (pending)`);
    });

    test("an agent whose model the switch has not installed yet renders the em-dash placeholder", () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        expect(modelStatusLines()[1]).toBe(`chat model: ${GLYPHS.emDash}`);
    });
});

// The session commands read the module-level boot store and the workspace scope. Thread metadata lives
// only in Postgres, so before `ready` there is nothing to list, retitle, remove, or restore; rename and
// delete additionally need a bound thread to act on, while restore acts on one the user picks. These
// drive the registry's own `enabled` predicates rather than a hand-rolled copy, so a re-wired gate
// fails here.
describe("session command gating", () => {
    // Only `id`/`name` are load-bearing (the predicates read the scope, not the row), so a partial
    // stand-in cast keeps the fixture flat — the same shape `workspace.test.ts` uses.
    const ANALYSIS = { id: "a1", name: "Alpha", projectId: null } as unknown as Analysis;

    /** A scope stand-in carrying only the two fields the session predicates read. */
    function scope(analysis: Analysis | null, sessionId: string | null): Workspace {
        return { analysis, sessionId } as unknown as Workspace;
    }

    /**
     * A command's availability under `ws`. `undefined` when the id is missing OR the command declares no
     * gate at all — both are registry regressions this suite must not read as "enabled", so the callers
     * assert against `true`/`false` rather than truthiness.
     */
    function enabledOf(id: CommandId, ws: Workspace): boolean | undefined {
        return commands.find((c) => c.id === id)?.enabled?.(ws);
    }

    const BOUND = scope(ANALYSIS, "thread-bound-1");

    test("none of them are available before boot reaches ready, even with a bound thread", () => {
        for (const phase of [{ phase: "idle" }, { phase: "booting" }, { phase: "failed", message: "postgres unreachable" }] as const) {
            __setBootStateForTest(phase);
            expect(enabledOf("session.switch", BOUND)).toBe(false);
            expect(enabledOf("session.rename", BOUND)).toBe(false);
            expect(enabledOf("session.delete", BOUND)).toBe(false);
            expect(enabledOf("session.restore", BOUND)).toBe(false);
            expect(enabledOf("session.purge", BOUND)).toBe(false);
        }
    });

    test("ready with no thread bound yet: switching and restoring are offered, rename and delete are not", () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        const unbound = scope(ANALYSIS, null);
        // Switching is how the user reaches an existing thread while the scope is still unbound, and
        // restoring names its own thread from the picker — neither needs one bound to act on.
        expect(enabledOf("session.switch", unbound)).toBe(true);
        expect(enabledOf("session.restore", unbound)).toBe(true);
        expect(enabledOf("session.rename", unbound)).toBe(false);
        expect(enabledOf("session.delete", unbound)).toBe(false);
        // Erasing needs a bound thread for the same reason removing does — there is no conversation to
        // name in the confirmation until one is.
        expect(enabledOf("session.purge", unbound)).toBe(false);
    });

    test("ready with a bound thread offers every session command", () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        expect(enabledOf("session.switch", BOUND)).toBe(true);
        expect(enabledOf("session.new", BOUND)).toBe(true);
        expect(enabledOf("session.rename", BOUND)).toBe(true);
        expect(enabledOf("session.delete", BOUND)).toBe(true);
        expect(enabledOf("session.restore", BOUND)).toBe(true);
        expect(enabledOf("session.purge", BOUND)).toBe(true);
    });

    // New session needs no bound thread (it mints its own), but it does need an analysis to mint under and
    // a ready runtime — a fresh id bound pre-`ready` would suppress the boot-edge open of the real thread.
    test("New session is offered exactly when an analysis is open and the runtime is ready", () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        expect(enabledOf("session.new", scope(ANALYSIS, null))).toBe(true);
        // No analysis: nothing to mint a conversation under.
        expect(enabledOf("session.new", scope(null, "thread-bound-1"))).toBe(false);
        // Not ready: the mint needs no Postgres, but the chat it opens onto cannot send a turn yet.
        __setBootStateForTest({ phase: "booting" });
        expect(enabledOf("session.new", BOUND)).toBe(false);
    });

    test("no analysis in scope: the analysis-scoped session commands stay unavailable", () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        const noAnalysis = scope(null, "thread-bound-1");
        expect(enabledOf("session.switch", noAnalysis)).toBe(false);
        expect(enabledOf("session.delete", noAnalysis)).toBe(false);
        expect(enabledOf("session.purge", noAnalysis)).toBe(false);
        // The archived listing is per-analysis, so with none open there is no set to draw from.
        expect(enabledOf("session.restore", noAnalysis)).toBe(false);
    });

    // The two thread verbs sit next to each other under one category and their titles differ by a word,
    // so the palette row is the only thing a user reads before choosing. One of them cannot be undone.
    test("remove and delete are separate entries whose descriptions cannot be confused", () => {
        const remove = commands.find((c) => c.id === "session.delete")!;
        const purge = commands.find((c) => c.id === "session.purge")!;

        expect(remove.title).toBe("Remove session");
        expect(purge.title).toBe("Delete session");
        expect(remove.description).toContain("transcript is kept");
        expect(purge.description).toContain("cannot be undone");
        // The recoverable one must never claim permanence, or the word stops meaning anything on the
        // row where it is true.
        expect(remove.description).not.toContain("cannot be undone");
    });
});

// The session flows (switch / rename / delete) and the in-place analysis open reach Postgres, the
// booted runtime, and the toast channel through `SessionSeams`, so every case here runs offline: the
// fakes resolve on the test's schedule, which is what makes the refusals, the degrades, and the
// interleaving of two rapid opens assertable at all.
describe("session flows", () => {
    // Only `id`/`name` are load-bearing (the flows pass the row through to `openSession`), so a partial
    // stand-in cast keeps the fixture flat.
    const ANALYSIS = { id: "a1", name: "Alpha", projectId: null } as unknown as Analysis;
    // The seams read only `.pool` off the handle and the fakes ignore it, so a partial stand-in cast
    // keeps every case offline. Mirrors `thread.test.ts`.
    const fakePool = {} as unknown as Pool;
    const fakeRuntime = { pool: fakePool } as unknown as HarnessRuntime;
    const dbErr: DbError = { type: "query_failed", op: "test", cause: new Error("boom") };
    const READY = { phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } } as const;

    function threadRow(over: Partial<Thread> = {}): Thread {
        return {
            threadId: "thread-1",
            analysisId: ANALYSIS.id,
            title: "Cohort survival questions",
            threadType: "conversation",
            parentThreadId: null,
            parentSeq: null,
            createdAt: new Date("2026-07-08T00:00:00.000Z"),
            updatedAt: new Date("2026-07-08T01:00:00.000Z"),
            // Live by default: the tombstone is what an archived row carries, and every flow but restore
            // only ever sees rows without one.
            deletedAt: null,
            ...over,
        };
    }

    function threadPage(threads: Thread[]): ThreadPage {
        return { threads, total: threads.length, page: 0, perPage: 20, hasMore: false };
    }

    /**
     * A workspace stand-in recording the two writes a session flow can make: dialogs and scope swaps.
     *
     * `swapTo` moves the open scope the way the user's own switch keys would. Each flow reads the scope
     * once, awaits Postgres, then acts — and nothing is modal across that await, so the switch keys stay
     * live. Driving the swap from inside a seam is how a test lands in that window deterministically.
     */
    function sessionScope(
        analysis: Analysis | null,
        sessionId: string | null,
    ): {
        ws: Workspace;
        dialogs: () => number;
        opened: { threadId: string | null; analysisId: string }[];
        swapTo: (next: { analysis?: Analysis; sessionId?: string | null }) => void;
    } {
        const opened: { threadId: string | null; analysisId: string }[] = [];
        let dialogs = 0;
        const scope: { analysis: Analysis | null; sessionId: string | null } = { analysis, sessionId };
        const ws = {
            get analysis() {
                return scope.analysis;
            },
            get sessionId() {
                return scope.sessionId;
            },
            workingDir: "/work",
            project: null,
            openDialog: () => {
                dialogs += 1;
            },
            closeDialog: () => {},
            openSession: (threadId: string | null, _workingDir: string, next: Analysis) => {
                opened.push({ threadId, analysisId: next.id });
            },
            quit: async () => {},
        } as unknown as Workspace;
        return {
            ws,
            dialogs: () => dialogs,
            opened,
            swapTo: (next) => {
                if (next.analysis !== undefined) scope.analysis = next.analysis;
                if (next.sessionId !== undefined) scope.sessionId = next.sessionId;
            },
        };
    }

    /** Seams plus recorders for the notices raised and the snapshot pokes issued. */
    function makeSeams(over: Partial<SessionSeams> = {}): { seams: SessionSeams; notices: Notice[]; refreshed: string[] } {
        const notices: Notice[] = [];
        const refreshed: string[] = [];
        const base: SessionSeams = {
            runtime: () => fakeRuntime,
            listThreads: () => okAsync(threadPage([])),
            listReportChildren: () => okAsync(threadPage([])),
            getThread: () => okAsync(null),
            updateTitle: () => okAsync(null),
            listThreadsWithArchived: () => okAsync(threadPage([])),
            archiveThread: () => okAsync<void, DbError>(undefined),
            unarchiveThread: () => okAsync<void, DbError>(undefined),
            purgeThread: () => okAsync<readonly string[], DbError>([]),
            // No root and no removal by default: a case that is not about the files says so by leaving
            // these alone, and a flow that reached the disk without being asked to shows up as a call.
            workspaceRootFor: () => null,
            removeReportSessionDir: async () => true,
            chatBusy: () => false,
            resolveThreadId: async () => "thread-resolved",
            workingDirFor: () => "/work",
            refreshThread: (threadId) => {
                refreshed.push(threadId);
            },
            notify: (n) => {
                notices.push(n);
            },
        };
        return { seams: { ...base, ...over }, notices, refreshed };
    }

    test("switch refuses before boot reaches ready, speaking rather than no-op'ing, and lists nothing", async () => {
        // The palette hides the command pre-`ready`, but its leader chord dispatches by id and bypasses
        // that predicate — so this path IS reachable while the runtime is still booting.
        __setBootStateForTest({ phase: "booting" });
        let listings = 0;
        const t = makeSeams({
            listThreads: () => {
                listings += 1;
                return okAsync(threadPage([]));
            },
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await openSwitchSession(w.ws, t.seams);

        expect(listings).toBe(0);
        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("info");
        expect(t.notices[0]?.text).toContain("booting");
    });

    test("switch on a FAILED boot says the harness did not start, not that it is still booting", async () => {
        // `failed` is terminal. "Still booting" would promise a wait that never ends, and contradict the
        // failure the status bar is already showing.
        __setBootStateForTest({ phase: "failed", message: "postgres unreachable" });
        const t = makeSeams();
        const w = sessionScope(ANALYSIS, "thread-1");

        await openSwitchSession(w.ws, t.seams);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("warn");
        expect(t.notices[0]?.text).toContain("did not start");
        expect(t.notices[0]?.text).not.toContain("booting");
    });

    test("a failed listing warns and still opens the picker — a degrade, never a crash", async () => {
        __setBootStateForTest(READY);
        const t = makeSeams({ listThreads: () => errAsync(dbErr) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await openSwitchSession(w.ws, t.seams);

        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("warn");
        // The picker still opens (on an empty list): the user keeps a working surface, and its empty
        // state is what tells them nothing could be listed.
        expect(w.dialogs()).toBe(1);
    });

    test("rename refuses BEFORE the prompt opens when the thread has no row yet", async () => {
        // The row is the first turn's job, so there is nothing to retitle until then — refusing up front
        // costs nothing, where refusing on submit spends the user's typing on a write that cannot land.
        const t = makeSeams({ getThread: () => okAsync(null) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await openRenameSession(w.ws, t.seams);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("warn");
        expect(t.notices[0]?.text).toContain("Send a message first");
    });

    test("switch refuses to open a picker built for an analysis the user has since left", async () => {
        // Nothing is modal across the listing round trip, so the analysis-switch keys are live. A picker
        // opened anyway lists the previous analysis's conversations, and selecting one binds that thread
        // beside the CURRENT analysis's working directory — one scope naming two analyses.
        __setBootStateForTest(READY);
        const OTHER = { id: "a2", name: "Beta", projectId: null } as unknown as Analysis;
        const w = sessionScope(ANALYSIS, "thread-1");
        const t = makeSeams({
            listThreads: () => {
                w.swapTo({ analysis: OTHER });
                return okAsync(threadPage([threadRow()]));
            },
        });

        await openSwitchSession(w.ws, t.seams);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.text).toContain("Analysis changed");
    });

    test("rename refuses to open a prompt for the session the user has since left", async () => {
        // "Rename session" means the one in front of you. A prompt pre-filled from the conversation just
        // navigated away from would retitle THAT one under a heading claiming to be about this one.
        const w = sessionScope(ANALYSIS, "thread-1");
        const t = makeSeams({
            getThread: () => {
                w.swapTo({ sessionId: "thread-2" });
                return okAsync(threadRow());
            },
        });

        await openRenameSession(w.ws, t.seams);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.text).toContain("Session changed");
    });

    test("remove refuses to confirm against the session the user has since left", async () => {
        // The costliest of the three: the confirmation would name the conversation just left, and
        // confirming it tombstones that one AND re-lands the chat — yanking the user off the session
        // they switched to, for a removal they never asked for there.
        const w = sessionScope(ANALYSIS, "thread-1");
        let archives = 0;
        const t = makeSeams({
            getThread: () => {
                w.swapTo({ sessionId: "thread-2" });
                return okAsync(threadRow());
            },
            archiveThread: () => {
                archives += 1;
                return okAsync<void, DbError>(undefined);
            },
        });

        await deleteSessionFlow(w.ws, t.seams);

        expect(w.dialogs()).toBe(0);
        expect(archives).toBe(0);
        expect(w.opened).toEqual([]); // nothing tombstoned, so nothing re-landed
        expect(t.notices[0]?.text).toContain("Session changed");
    });

    test("rename distinguishes a FAILED read from an absent row — no false claim about the user's data", async () => {
        // Both refuse, and both refuse before the prompt; the difference is what they assert. Collapsing
        // the read failure into the branch above would tell a user whose Postgres blinked that they have
        // no saved conversation, and hand them a remedy ("send a message first") that cannot help.
        const t = makeSeams({ getThread: () => errAsync(dbErr) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await openRenameSession(w.ws, t.seams);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("error");
        expect(t.notices[0]?.text).toContain("Could not read");
        expect(t.notices[0]?.text).not.toContain("Send a message first");
    });

    test("rename opens the prompt on a live row, pre-filled from the pg title", async () => {
        const t = makeSeams({ getThread: () => okAsync(threadRow()) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await openRenameSession(w.ws, t.seams);

        expect(w.dialogs()).toBe(1);
        expect(t.notices).toEqual([]);
    });

    test("a rename whose row vanished between the prompt and the submit warns instead of reporting success", async () => {
        // The concurrent-delete backstop: `updateTitle` is a no-op on a missing row, so a silent success
        // would claim a title the sidebar will never show.
        const t = makeSeams({ updateTitle: () => okAsync(null) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await commitSessionRename(w.ws, fakePool, "thread-1", "Variant burden sweep", t.seams);

        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("warn");
        expect(t.refreshed).toEqual([]); // nothing changed, so nothing to repaint
    });

    test("a committed rename pokes the open-thread snapshot, since the bound id never changed", async () => {
        const t = makeSeams({ updateTitle: (_pool, threadId, title) => okAsync(threadRow({ threadId, title })) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await commitSessionRename(w.ws, fakePool, "thread-1", "  Variant burden sweep  ", t.seams);

        expect(t.notices[0]?.kind).toBe("info");
        expect(t.notices[0]?.text).toContain("Variant burden sweep"); // trimmed before it is written
        expect(t.refreshed).toEqual(["thread-1"]);
    });

    test("a rename that lands after the user swapped sessions reports success but does NOT repaint the rail", async () => {
        // The prompt closes on submit, so the palette is reachable again while the write is in flight.
        // Poking the snapshot for the renamed thread would then load it over the conversation the user
        // actually has open — the exact cross-thread repaint the snapshot's id check exists to stop.
        const t = makeSeams({ updateTitle: (_pool, threadId, title) => okAsync(threadRow({ threadId, title })) });
        const w = sessionScope(ANALYSIS, "thread-moved-on");

        await commitSessionRename(w.ws, fakePool, "thread-1", "Variant burden sweep", t.seams);

        // The write DID land, so the user is told so.
        expect(t.notices[0]?.kind).toBe("info");
        expect(t.notices[0]?.text).toContain("Variant burden sweep");
        expect(t.refreshed).toEqual([]);
    });

    test("a rename write failure surfaces the error and leaves the rail alone", async () => {
        const t = makeSeams({ updateTitle: () => errAsync(dbErr) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await commitSessionRename(w.ws, fakePool, "thread-1", "Variant burden sweep", t.seams);

        expect(t.notices[0]?.kind).toBe("error");
        expect(t.refreshed).toEqual([]);
    });

    test("delete says there is nothing to remove when the conversation has no saved row", async () => {
        // Confirming against a name we do not have would ask the user to type a fiction.
        const t = makeSeams({ getThread: () => okAsync(null) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await deleteSessionFlow(w.ws, t.seams);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("info");
        expect(t.notices[0]?.text).toContain("nothing to remove");
    });

    test("delete distinguishes a FAILED read from an absent row, and says nothing was removed", async () => {
        const t = makeSeams({ getThread: () => errAsync(dbErr) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await deleteSessionFlow(w.ws, t.seams);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("error");
        expect(t.notices[0]?.text).toContain("Could not read");
        expect(t.notices[0]?.text).not.toContain("nothing saved yet");
    });

    test("a confirmed delete re-lands the chat on the analysis's surviving thread", async () => {
        const t = makeSeams({ resolveThreadId: async () => "thread-survivor" });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionDelete(w.ws, fakePool, ANALYSIS, "thread-1", t.seams);

        expect(t.notices[0]?.kind).toBe("info");
        // The write is a tombstone, so the notice reports the reach it actually has. Claiming a
        // deletion would be the one thing this flow cannot back up — the transcript stays in Postgres.
        expect(t.notices[0]?.text).toContain("no longer appears");
        expect(t.notices[0]?.text).not.toContain("deleted");
        // Unbound FIRST, then landed. The scope is never left naming the tombstone across the landing's
        // round trip: a turn submitted there would append onto a thread that lists nowhere, putting the
        // user's message somewhere they can never read it. `null` refuses that submit and keeps the text.
        expect(w.opened).toEqual([
            { threadId: null, analysisId: ANALYSIS.id },
            { threadId: "thread-survivor", analysisId: ANALYSIS.id },
        ]);
    });

    test("the unbind precedes the landing round trip, not just its result", async () => {
        // Asserting the ORDER of the two writes is not enough — both land by the time the flow returns
        // either way. What matters is that the unbind is already visible while the landing's listing is
        // still in flight, because that is the whole window a submit could slip into.
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const t = makeSeams({ resolveThreadId: async () => (await gate, "thread-survivor") });
        const w = sessionScope(ANALYSIS, "thread-1");

        const flow = confirmSessionDelete(w.ws, fakePool, ANALYSIS, "thread-1", t.seams);
        await Promise.resolve(); // let the delete settle and the unbind land

        expect(w.opened).toEqual([{ threadId: null, analysisId: ANALYSIS.id }]);

        release();
        await flow;
        expect(w.opened.at(-1)).toEqual({ threadId: "thread-survivor", analysisId: ANALYSIS.id });
    });

    test("a failed delete surfaces the error and leaves the user where they were", async () => {
        const t = makeSeams({ archiveThread: () => errAsync(dbErr) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionDelete(w.ws, fakePool, ANALYSIS, "thread-1", t.seams);

        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("error");
        expect(w.opened).toEqual([]); // the thread still lists, so nothing is re-landed
    });

    // The hard delete repeats the removal flow's shape, so what these cases pin is the ONE thing that
    // must differ: which store verb runs. A delete that quietly archived would look correct from every
    // notice and every landing, and the transcript the user asked to erase would still be there.
    test("a confirmed delete erases the thread and re-lands the chat on a surviving conversation", async () => {
        const purged: string[] = [];
        let archives = 0;
        const t = makeSeams({
            resolveThreadId: async () => "thread-survivor",
            purgeThread: (_pool, threadId) => {
                purged.push(threadId);
                return okAsync<readonly string[], DbError>([threadId]);
            },
            archiveThread: () => {
                archives += 1;
                return okAsync<void, DbError>(undefined);
            },
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionPurge(w.ws, fakePool, ANALYSIS, "thread-1", "keep", t.seams);

        expect(purged).toEqual(["thread-1"]);
        expect(archives).toBe(0); // a tombstone here would keep the transcript the user asked to erase
        expect(t.notices[0]?.kind).toBe("info");
        expect(t.notices[0]?.text).toContain("transcript is gone");
        // Unbound FIRST, then landed — the same tail removal runs, and it matters more here: across the
        // landing's round trip the scope would otherwise name an id whose row is gone, and a turn
        // submitted into it would mint that row back as an empty conversation.
        expect(w.opened).toEqual([
            { threadId: null, analysisId: ANALYSIS.id },
            { threadId: "thread-survivor", analysisId: ANALYSIS.id },
        ]);
    });

    test("delete refuses to confirm against the session the user has since left", async () => {
        // The costliest window in the app: the confirmation would name the conversation just left, and
        // typing that name would erase it — with no restore to undo it.
        const w = sessionScope(ANALYSIS, "thread-1");
        let purges = 0;
        const t = makeSeams({
            getThread: () => {
                w.swapTo({ sessionId: "thread-2" });
                return okAsync(threadRow());
            },
            purgeThread: () => {
                purges += 1;
                return okAsync<readonly string[], DbError>([]);
            },
        });

        await purgeSessionFlow(w.ws, t.seams);

        expect(w.dialogs()).toBe(0);
        expect(purges).toBe(0);
        expect(w.opened).toEqual([]); // nothing erased, so nothing re-landed
        expect(t.notices[0]?.text).toContain("Session changed");
    });

    test("delete says there is nothing to erase when the conversation has no saved row", async () => {
        // Confirming against a name we do not have would ask the user to type a fiction — and for the
        // one action where a mistyped confirmation is unrecoverable.
        const t = makeSeams({ getThread: () => okAsync(null) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await purgeSessionFlow(w.ws, t.seams);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("info");
        expect(t.notices[0]?.text).toContain("nothing to delete");
    });

    test("delete distinguishes a FAILED read from an absent row, and says nothing was deleted", async () => {
        const t = makeSeams({ getThread: () => errAsync(dbErr) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await purgeSessionFlow(w.ws, t.seams);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("error");
        expect(t.notices[0]?.text).toContain("Could not read");
        expect(t.notices[0]?.text).toContain("nothing was deleted");
    });

    test("delete refuses while a turn is streaming into the conversation, before reading or confirming", async () => {
        // The purge is unrecoverable and `appendTurn` has no foreign key to the thread row: a turn
        // committing after it lands messages under a `thread_id` that resolves to no analysis, which no
        // later reclamation can reach. The harness states this precondition and cannot enforce it, so
        // the refusal has to be here — and ahead of the read, so the user never types a name for an
        // action that was never going to run.
        let reads = 0;
        let purges = 0;
        const t = makeSeams({
            chatBusy: () => true,
            getThread: () => {
                reads += 1;
                return okAsync(threadRow());
            },
            purgeThread: () => {
                purges += 1;
                return okAsync<readonly string[], DbError>([]);
            },
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await purgeSessionFlow(w.ws, t.seams);

        expect(reads).toBe(0);
        expect(purges).toBe(0);
        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("warn");
        expect(t.notices[0]?.text).toContain("chat turn is running");
    });

    test("remove does NOT refuse while a turn is streaming — an archive is recoverable", async () => {
        // Deliberately asymmetric with delete. A turn landing after an archive leaves its messages on a
        // tombstoned row, and Restore brings the thread back with them intact — so blocking the action
        // would cost the user a working command to protect against nothing.
        const t = makeSeams({ chatBusy: () => true, getThread: () => okAsync(threadRow()) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await deleteSessionFlow(w.ws, t.seams);

        expect(w.dialogs()).toBe(1);
        expect(t.notices).toEqual([]);
    });

    test("remove and delete both SPEAK when the harness is down, rather than swallowing the keystroke", async () => {
        // Same bypass the pre-`ready` refusals above cover: the palette gates both commands on a booted
        // harness, and the leader chord dispatches by id without consulting `enabled`. A silent return
        // there reads to the user as a dead key on a command the palette lists.
        for (const flow of [deleteSessionFlow, purgeSessionFlow]) {
            const t = makeSeams({ runtime: () => null, getThread: () => okAsync(threadRow()) });
            const w = sessionScope(ANALYSIS, "thread-1");

            await flow(w.ws, t.seams);

            expect(t.notices).toHaveLength(1);
            expect(t.notices[0]!.text).toContain("harness is not running");
            // Nothing was read and nothing was confirmed: the refusal is the whole of what happened.
            expect(w.dialogs()).toBe(0);
        }
    });

    test("delete opens the confirmation on a live row, naming the conversation to type back", async () => {
        const t = makeSeams({ getThread: () => okAsync(threadRow()) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await purgeSessionFlow(w.ws, t.seams);

        expect(w.dialogs()).toBe(1);
        expect(t.notices).toEqual([]);
    });

    test("a failed delete surfaces the error and leaves the user on the conversation", async () => {
        const t = makeSeams({ purgeThread: () => errAsync(dbErr) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionPurge(w.ws, fakePool, ANALYSIS, "thread-1", "keep", t.seams);

        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("error");
        expect(w.opened).toEqual([]); // the thread is still there, so nothing is re-landed
    });

    // The page directory of a report session takes the name of its thread id, and the erase is the only
    // source for the set of ids it took — after it, no listing names them. These cases pin the file half
    // of the delete: what the user is asked, when the removal may run, and what a page that survives it
    // does to the outcome.
    const tmpRoots: string[] = [];
    afterEach(() => {
        for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    /** A workspace root holding one page directory per id, removed when the case ends. */
    function pageRoot(ids: readonly string[]): string {
        const dir = mkdtempSync(join(tmpdir(), "inflexa-session-pages-"));
        tmpRoots.push(dir);
        for (const id of ids) mkdirSync(join(dir, reportSessionDir(id)), { recursive: true });
        return dir;
    }

    test("the file question is asked on every delete: nothing on disk is read before it", async () => {
        // The erase names the threads it took, and it names them only after it runs. A question that
        // waited for a directory to exist could therefore only be asked past the point of no return.
        let roots = 0;
        let removals = 0;
        const t = makeSeams({
            getThread: () => okAsync(threadRow()),
            workspaceRootFor: () => {
                roots += 1;
                return null;
            },
            removeReportSessionDir: async () => {
                removals += 1;
                return true;
            },
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await purgeSessionFlow(w.ws, t.seams);

        expect(w.dialogs()).toBe(1);
        expect(roots).toBe(0);
        expect(removals).toBe(0);
    });

    test("a subtree that owns no page removes nothing and reports no failure", async () => {
        // Driven through the REAL removal seam, because the property under test is the forced removal:
        // an absent directory is a success, which is what lets the question precede the erase.
        const root = pageRoot([]);
        writeFileSync(join(root, "runs.txt"), "x");
        const t = makeSeams({
            purgeThread: () => okAsync<readonly string[], DbError>(["thread-1"]),
            workspaceRootFor: () => root,
            removeReportSessionDir: realSessionSeams.removeReportSessionDir,
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionPurge(w.ws, fakePool, ANALYSIS, "thread-1", "remove", t.seams);

        // The rest of the workspace is not this flow's to touch: only a page directory is.
        expect(existsSync(join(root, "runs.txt"))).toBe(true);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("info");
        expect(t.notices[0]?.text).toContain("transcript is gone");
    });

    test("the accept removes the page directory of every thread the erase took", async () => {
        // The reports are the point: a delete that reclaimed the conversation's own directory only would
        // leave each report page behind with nothing left that can name it.
        const erased = ["thread-1", "report-a", "report-b"];
        const root = pageRoot(erased);
        const t = makeSeams({
            purgeThread: () => okAsync<readonly string[], DbError>(erased),
            workspaceRootFor: () => root,
            removeReportSessionDir: realSessionSeams.removeReportSessionDir,
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionPurge(w.ws, fakePool, ANALYSIS, "thread-1", "remove", t.seams);

        for (const id of erased) expect(existsSync(join(root, reportSessionDir(id)))).toBe(false);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("info");
        expect(t.notices[0]?.text).toContain("report files are removed");
    });

    test("the decline erases the rows and leaves every page directory on disk", async () => {
        const erased = ["thread-1", "report-a"];
        const root = pageRoot(erased);
        let purges = 0;
        let removals = 0;
        const t = makeSeams({
            purgeThread: () => {
                purges += 1;
                return okAsync<readonly string[], DbError>(erased);
            },
            workspaceRootFor: () => root,
            removeReportSessionDir: async () => {
                removals += 1;
                return true;
            },
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionPurge(w.ws, fakePool, ANALYSIS, "thread-1", "keep", t.seams);

        expect(purges).toBe(1); // the rows go either way — the choice governs the files alone
        expect(removals).toBe(0);
        for (const id of erased) expect(existsSync(join(root, reportSessionDir(id)))).toBe(true);
        expect(t.notices[0]?.text).toContain("report files are kept");
    });

    test("a failed erase leaves every file, even where the user asked to remove them", async () => {
        // The rows survive a failed erase, thus each page is still reachable from them. Removing the
        // files anyway would strip a conversation the user can still open.
        let removals = 0;
        const t = makeSeams({
            purgeThread: () => errAsync(dbErr),
            workspaceRootFor: () => "/root",
            removeReportSessionDir: async () => {
                removals += 1;
                return true;
            },
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionPurge(w.ws, fakePool, ANALYSIS, "thread-1", "remove", t.seams);

        expect(removals).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("error");
        expect(w.opened).toEqual([]);
    });

    test("a page directory that resists removal keeps the delete a success and is named in the notice", async () => {
        // The rows are gone and nothing restores them, so a file left behind cannot make this a failed
        // delete. Naming the directory is the whole remedy the user has: after the erase, no surface
        // can name it for them.
        const root = "/root";
        const stubborn = join(root, reportSessionDir("report-b"));
        const t = makeSeams({
            purgeThread: () => okAsync<readonly string[], DbError>(["thread-1", "report-b"]),
            workspaceRootFor: () => root,
            removeReportSessionDir: async (dir) => dir !== stubborn,
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionPurge(w.ws, fakePool, ANALYSIS, "thread-1", "remove", t.seams);

        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("warn");
        expect(t.notices[0]?.text).toContain("transcript is gone");
        expect(t.notices[0]?.text).toContain(stubborn);
        // The one that went is not named: the list is what is left to deal with, not a report of the work.
        expect(t.notices[0]?.text).not.toContain(join(root, reportSessionDir("thread-1")));
        // Unbound and re-landed exactly as a clean delete is — a stayed directory changes nothing here.
        expect(w.opened).toEqual([
            { threadId: null, analysisId: ANALYSIS.id },
            { threadId: "thread-resolved", analysisId: ANALYSIS.id },
        ]);
    });

    // The moment a removal stamped the tombstone. Distinct from the fixture's activity clock, which the
    // archive deliberately leaves alone, so an assertion can tell the two stamps apart.
    const ARCHIVED_AT = new Date("2026-07-09T09:30:00.000Z");

    test("restore refuses before boot reaches ready, speaking rather than no-op'ing, and lists nothing", async () => {
        // Reachable pre-`ready` for the same reason the switch picker is: the leader chord dispatches by
        // id and bypasses the palette's `enabled` predicate.
        __setBootStateForTest({ phase: "booting" });
        let listings = 0;
        const t = makeSeams({
            listThreadsWithArchived: () => {
                listings += 1;
                return okAsync(threadPage([]));
            },
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await openRestoreSession(w.ws, t.seams);

        expect(listings).toBe(0);
        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("info");
        expect(t.notices[0]?.text).toContain("booting");
    });

    test("restore on a FAILED boot says the harness did not start, not that it is still booting", async () => {
        __setBootStateForTest({ phase: "failed", message: "postgres unreachable" });
        const t = makeSeams();
        const w = sessionScope(ANALYSIS, "thread-1");

        await openRestoreSession(w.ws, t.seams);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("warn");
        expect(t.notices[0]?.text).toContain("did not start");
        expect(t.notices[0]?.text).not.toContain("booting");
    });

    test("restore refuses to open a picker built for an analysis the user has since left", async () => {
        // Nothing is modal across the listing round trip, so the analysis-switch keys are live. A picker
        // opened anyway would offer the PREVIOUS analysis's archived conversations under a heading
        // claiming to be about the current one, and restoring from it would return a conversation to an
        // analysis the user is no longer looking at.
        __setBootStateForTest(READY);
        const OTHER = { id: "a2", name: "Beta", projectId: null } as unknown as Analysis;
        const w = sessionScope(ANALYSIS, "thread-1");
        const t = makeSeams({
            listThreadsWithArchived: () => {
                w.swapTo({ analysis: OTHER });
                return okAsync(threadPage([threadRow({ deletedAt: ARCHIVED_AT })]));
            },
        });

        await openRestoreSession(w.ws, t.seams);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.text).toContain("Analysis changed");
    });

    test("a failed archived listing warns and opens NO picker, so no empty state claims nothing was archived", async () => {
        __setBootStateForTest(READY);
        const t = makeSeams({ listThreadsWithArchived: () => errAsync(dbErr) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await openRestoreSession(w.ws, t.seams);

        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("warn");
        // Degrading to an empty picker would render "No archived conversations" — a positive statement
        // about the user's data that a failed read cannot support, and indistinguishable from the truth.
        expect(w.dialogs()).toBe(0);
    });

    test("restore walks past the first page, so archived rows sorting behind live ones are still found", async () => {
        // The widened listing orders by activity and the archive leaves `updated_at` alone, so every
        // archived row sorts behind every live one used since. A picker reading one page would show
        // none of them here and state outright that there are none.
        __setBootStateForTest(READY);
        const pages: ThreadPage[] = [
            { threads: [threadRow({ threadId: "live-1" })], total: 2, page: 0, perPage: 1, hasMore: true },
            { threads: [threadRow({ threadId: "archived-1", deletedAt: ARCHIVED_AT })], total: 2, page: 1, perPage: 1, hasMore: false },
        ];
        const asked: number[] = [];
        const t = makeSeams({
            listThreadsWithArchived: (_pool, _analysisId, page) => {
                asked.push(page);
                return okAsync(pages[page]!);
            },
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await openRestoreSession(w.ws, t.seams);

        expect(asked).toEqual([0, 1]);
        expect(w.dialogs()).toBe(1);
        expect(t.notices).toEqual([]);
    });

    test("restore stops walking and says the listing is partial rather than presenting it as complete", async () => {
        // A store that never stops reporting more must not spin the picker forever, and the bounded walk
        // it gets instead must not then pass its partial set off as the whole set.
        __setBootStateForTest(READY);
        let asked = 0;
        const t = makeSeams({
            listThreadsWithArchived: () => {
                asked += 1;
                return okAsync({ threads: [threadRow({ deletedAt: ARCHIVED_AT })], total: 9999, page: 0, perPage: 1, hasMore: true });
            },
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await openRestoreSession(w.ws, t.seams);

        expect(asked).toBeLessThan(100); // bounded, not spinning
        expect(w.dialogs()).toBe(1); // what WAS found is still offered
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("warn");
        expect(t.notices[0]?.text).toContain("not listed");
    });

    test("a restore lifts the chosen conversation's tombstone and names it in the notice", async () => {
        const restored: string[] = [];
        const t = makeSeams({
            unarchiveThread: (_pool, threadId) => {
                restored.push(threadId);
                return okAsync<void, DbError>(undefined);
            },
        });

        await commitSessionRestore(fakePool, threadRow({ threadId: "thread-archived", title: "Variant burden sweep", deletedAt: ARCHIVED_AT }), t.seams);

        expect(restored).toEqual(["thread-archived"]);
        expect(t.notices[0]?.kind).toBe("info");
        expect(t.notices[0]?.text).toContain("Variant burden sweep");
    });

    test("a failed restore surfaces the error rather than claiming the conversation is back", async () => {
        const t = makeSeams({ unarchiveThread: () => errAsync(dbErr) });

        await commitSessionRestore(fakePool, threadRow({ title: "Variant burden sweep", deletedAt: ARCHIVED_AT }), t.seams);

        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("error");
        // The thread is still archived, so the one claim this outcome cannot make is that it is listing
        // again.
        expect(t.notices[0]?.text).not.toContain("appears in this analysis again");
    });

    test("two rapid opens: the one STARTED last wins, even when the older listing resolves last", async () => {
        // Both resolutions are Postgres round-trips; without the generation token the slower (older) one
        // would land last and drop the user back on the analysis they just moved off.
        const OTHER = { id: "a2", name: "Bravo", projectId: null } as unknown as Analysis;
        let releaseSlow!: () => void;
        const gate = new Promise<void>((r) => {
            releaseSlow = r;
        });
        const slow = makeSeams({ resolveThreadId: async () => gate.then(() => "thread-alpha") });
        const fast = makeSeams({ resolveThreadId: async () => "thread-bravo" });
        const w = sessionScope(ANALYSIS, null);

        const stale = openAnalysis(w.ws, ANALYSIS, slow.seams); // parks on its gate
        await openAnalysis(w.ws, OTHER, fast.seams); // starts later, settles first

        releaseSlow();
        await stale;

        expect(w.opened).toEqual([{ threadId: "thread-bravo", analysisId: OTHER.id }]);
    });

    // The new-session flow's whole output is the mint it hands `openSession`, so its id, working dir, and
    // analysis all have to be observable — `sessionScope` above records only the id + analysis, so these
    // cases use a recorder that keeps every argument. Its `closes` counter proves the picker's creation
    // row dismisses the dialog before swapping.
    function recordingScope(
        analysis: Analysis | null,
        sessionId: string | null,
    ): { ws: Workspace; opened: { threadId: string | null; workingDir: string; analysisId: string }[]; closes: () => number } {
        const opened: { threadId: string | null; workingDir: string; analysisId: string }[] = [];
        let closes = 0;
        const ws = {
            analysis,
            sessionId,
            workingDir: "/work",
            project: null,
            openDialog: () => {},
            closeDialog: () => {
                closes += 1;
            },
            openSession: (threadId: string | null, workingDir: string, next: Analysis) => {
                opened.push({ threadId, workingDir, analysisId: next.id });
            },
            quit: async () => {},
        } as unknown as Workspace;
        return { ws, opened, closes: () => closes };
    }

    test("New session mints a fresh id and swaps to it in the same analysis and working dir", () => {
        __setBootStateForTest(READY);
        const t = makeSeams();
        const w = recordingScope(ANALYSIS, "thread-current");

        newSessionFlow(w.ws, t.seams);

        expect(w.opened).toHaveLength(1);
        expect(w.opened[0]?.analysisId).toBe(ANALYSIS.id);
        expect(w.opened[0]?.workingDir).toBe("/work");
        // A genuinely fresh identity, never the one already open, and never null (that is the unbound state).
        expect(w.opened[0]?.threadId).toBeTruthy();
        expect(w.opened[0]?.threadId).not.toBe("thread-current");
        // Success is silent: the swap is the whole of what the user sees.
        expect(t.notices).toEqual([]);
    });

    test("two New session invocations mint two different ids", () => {
        __setBootStateForTest(READY);
        const t = makeSeams();
        const w = recordingScope(ANALYSIS, null);

        newSessionFlow(w.ws, t.seams);
        newSessionFlow(w.ws, t.seams);

        expect(w.opened).toHaveLength(2);
        expect(w.opened[0]?.threadId).not.toBe(w.opened[1]?.threadId);
    });

    test("New session dispatched by id before ready speaks the refusal and swaps nothing", () => {
        // The palette hides the command pre-`ready`, but a by-id dispatch skips `enabled`, so the body
        // carries the same phase refusal the switch picker does — warn on the terminal `failed`, an
        // in-progress notice on every other non-ready phase.
        __setBootStateForTest({ phase: "failed", message: "postgres unreachable" });
        const failed = makeSeams();
        const wf = recordingScope(ANALYSIS, "thread-1");

        newSessionFlow(wf.ws, failed.seams);

        expect(wf.opened).toEqual([]);
        expect(failed.notices).toHaveLength(1);
        expect(failed.notices[0]?.kind).toBe("warn");
        expect(failed.notices[0]?.text).toContain("did not start");
        expect(failed.notices[0]?.text).not.toContain("booting");

        __setBootStateForTest({ phase: "booting" });
        const booting = makeSeams();
        const wb = recordingScope(ANALYSIS, "thread-1");

        newSessionFlow(wb.ws, booting.seams);

        expect(wb.opened).toEqual([]);
        expect(booting.notices).toHaveLength(1);
        expect(booting.notices[0]?.kind).toBe("info");
        expect(booting.notices[0]?.text).toContain("booting");
    });

    test("the switch picker offers a pinned creation row, present even with zero threads", () => {
        const items = switchSessionItems([]);
        const creationRow = items.find((i) => i.pinned);
        expect(creationRow).toBeDefined();
        expect(creationRow?.title).toBe("Start a new session");
        // With no threads it is the ONLY row, so the picker is never empty and the create action is always
        // reachable.
        expect(items).toHaveLength(1);
    });

    test("with threads present the creation row comes LAST, after the threads in their given order", () => {
        // The default selection must stay the most-recent thread, so the create action — the escape hatch
        // out of the list — sits at the end. Last-placement is also the position stable across filter
        // states: a query matching no thread re-appends dropped pinned rows at the end, so a pinned row
        // placed first would jump to the back the moment the user starts filtering.
        const first = threadRow({ threadId: "thread-newest", title: "Newest" });
        const second = threadRow({ threadId: "thread-older", title: "Older" });

        const items = switchSessionItems([first, second]);

        expect(items).toHaveLength(3);
        // The thread rows keep their given order, ahead of the creation row.
        expect(items[0]?.value).toBe(first);
        expect(items[1]?.value).toBe(second);
        // The pinned creation row is last.
        const last = items[items.length - 1];
        expect(last?.pinned).toBe(true);
        expect(last?.title).toBe("Start a new session");
        // Only that row is pinned — the threads rank normally, so the newest stays the default selection.
        expect(items.filter((i) => i.pinned)).toHaveLength(1);
    });

    test("selecting the creation row closes the dialog and swaps onto a fresh mint", () => {
        __setBootStateForTest(READY);
        const t = makeSeams();
        const w = recordingScope(ANALYSIS, "thread-current");
        // The sentinel is whatever value the pinned row carries — the test names it the way a pick does.
        // `switchSessionItems` always includes that one pinned row, so this find never misses.
        const sentinel = switchSessionItems([]).find((i) => i.pinned)!.value;

        selectSwitchSession(w.ws, sentinel, ANALYSIS, t.seams);

        expect(w.closes()).toBe(1);
        expect(w.opened).toHaveLength(1);
        expect(w.opened[0]?.analysisId).toBe(ANALYSIS.id);
        expect(w.opened[0]?.threadId).toBeTruthy();
        expect(w.opened[0]?.threadId).not.toBe("thread-current");
    });

    test("selecting a thread row closes the dialog and swaps onto that thread", () => {
        __setBootStateForTest(READY);
        const t = makeSeams();
        const w = recordingScope(ANALYSIS, "thread-current");
        const row = threadRow({ threadId: "thread-picked" });

        selectSwitchSession(w.ws, row, ANALYSIS, t.seams);

        expect(w.closes()).toBe(1);
        expect(w.opened).toEqual([{ threadId: "thread-picked", workingDir: "/work", analysisId: ANALYSIS.id }]);
    });
});

// The panel's restore affordance is exposed BOTH ways — a chord and a palette command — mirroring how
// the sidebar toggle is. A user who dismissed the panel and does not recall the chord needs the
// palette entry, which is precisely why it is restore-only rather than a second toggle: a toggle
// there could hide the panel a second time and read as the command having done nothing.
describe("activity-panel palette command", () => {
    test("restore is reachable from the palette, in the View category", () => {
        const cmd = commands.find((c) => c.id === "view.activity-panel");
        expect(cmd).toBeDefined();
        expect(cmd!.category).toBe("View");
        // Discoverable by what a user would actually type after losing the panel.
        expect(`${cmd!.title} ${cmd!.description}`.toLowerCase()).toContain("activity panel");
    });

    test("the command is restore-only, not a second toggle", () => {
        const cmd = commands.find((c) => c.id === "view.activity-panel")!;
        // Behaviour is asserted in activity_panel.test.ts, where an active run can be seeded; what matters
        // here is that the palette entry calls the restore, never the toggle — a toggle in the palette
        // could hide the panel a second time and read as the command having done nothing.
        expect(cmd.run.toString()).toContain("restoreActivityPanel");
    });
});

// The export's ordering is only observable on disk: "signed before written" and "written then signed"
// differ solely in what survives a signing failure. These drive the real `mkdir`/`writeFile` against a
// temp directory for that reason — a recorded call list would prove the calls happened in an order,
// not that a failure left the destination untouched.
describe("palette provenance export", () => {
    const ANALYSIS = { id: "a1", name: "Alpha", slug: "alpha", anchorId: "anchor-1", projectId: null } as unknown as Analysis;
    const DOCUMENT = '{"prefix":{},"entity":{}}';
    const ATTESTATION: ProvAttestation = {
        payloadType: "application/json; profile=prov-json",
        payloadDigestAlgorithm: "SHA-256",
        payloadDigest: "8f43",
        payloadDigestMethod: "verbatim",
        signatureAlgorithm: "Ed25519",
        signature: "3a91",
        publicKey: { kty: "OKP", crv: "Ed25519", x: "abc" },
    };

    let root: string;
    let out: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "inflexa-prov-export-"));
        // Deliberately NOT created: the export's own `mkdir` is what brings it into being, so its
        // absence afterwards proves nothing was written rather than merely that a file is missing.
        out = join(root, "analyses", "alpha");
        __resetNoticesForTest();
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
        __resetNoticesForTest();
    });

    /** The three edges, with the signature outcome the case is about. */
    function seams(attestation: ProvExportSeams["buildAttestation"]): ProvExportSeams {
        return {
            resolveOutputDir: () => ok<string, WorkspaceError>(out),
            serializeProvenance: () => ok<string, SqliteError>(DOCUMENT),
            buildAttestation: attestation,
        };
    }

    test("a signing failure writes neither the document nor the attestation", async () => {
        const exported = await exportProvenanceToFile(
            ANALYSIS,
            "json",
            seams(async () => err<ProvAttestation, SigningError>({ type: "keypair_race_lost" })),
        );

        // The delete flow reads this to caveat its own outcome notice, so an unwritten export must
        // never report success back to a caller exporting on the user's behalf.
        expect(exported).toBe(false);
        expect(existsSync(join(out, "provenance.json"))).toBe(false);
        expect(existsSync(join(out, "provenance.json.sig.json"))).toBe(false);
        // Nothing at all, not even the directory the write would have needed: an unsigned document
        // beneath a notice claiming provenance is never exported unsigned is the failure being fixed.
        expect(existsSync(out)).toBe(false);
        expect(currentNotice()?.kind).toBe("error");
        expect(currentNotice()?.text).toContain("never exported unsigned");
    });

    test("a successful signature writes the document and its attestation together", async () => {
        const exported = await exportProvenanceToFile(
            ANALYSIS,
            "json",
            seams(async () => ok<ProvAttestation, SigningError>(ATTESTATION)),
        );

        expect(exported).toBe(true);
        expect(readFileSync(join(out, "provenance.json"), "utf8")).toBe(DOCUMENT);
        expect(JSON.parse(readFileSync(join(out, "provenance.json.sig.json"), "utf8"))).toEqual(ATTESTATION);
        expect(currentNotice()?.kind).toBe("info");
        expect(currentNotice()?.text).toContain(join(out, "provenance.json"));
    });
});

// The delete ladder's contract IS its order, so every case here asserts the recorded stage sequence
// rather than whether each stage ran: a suite that only counted calls would stay green with the purge
// moved after the row delete, which is the failure mode that strands an analysis's Postgres footprint
// beyond any retry while reporting success.
describe("analysis delete ladder", () => {
    const ANALYSIS = { id: "a1", name: "Alpha", slug: "alpha", anchorId: "anchor-1", projectId: null } as unknown as Analysis;
    const SURVIVOR = { id: "a2", name: "Beta", slug: "beta", anchorId: "anchor-1", projectId: null } as unknown as Analysis;
    const fakePool = {} as unknown as Pool;
    const fakeRuntime = { pool: fakePool } as unknown as HarnessRuntime;
    const ARCHIVE_PATH = "/work/.inflexa/analyses_archived/alpha";
    const PURGED: AnalysisPurgeOutcome = { threads: 2, messages: 40, workflows: 3, vectorIndexDropped: true };
    const pgErr: DbError = { type: "query_failed", op: "purgeAnalysis", cause: new Error("boom") };

    /** What each stage of one run reports back; every stage still records itself either way. */
    type LadderOutcomes = {
        /** `null` stands in for a harness that never booted. */
        runtime?: HarnessRuntime | null;
        flushed?: boolean;
        exported?: boolean;
        disposal?: WorkspaceDisposal;
        disposalError?: WorkspaceError;
        purgeError?: DbError;
        rowsDeleted?: number;
        remaining?: Analysis[];
    };

    function ladder(out: LadderOutcomes = {}): {
        seams: AnalysisDeleteSeams;
        steps: string[];
        notices: Notice[];
        purged: { pool: Pool; analysisId: string }[];
    } {
        const steps: string[] = [];
        const notices: Notice[] = [];
        const purged: { pool: Pool; analysisId: string }[] = [];
        const runtime = out.runtime === undefined ? fakeRuntime : out.runtime;
        const seams: AnalysisDeleteSeams = {
            runtime: () => runtime,
            hasWorkspaceOnDisk: () => true,
            flushProvenance: async () => {
                steps.push("flush");
                return out.flushed ?? true;
            },
            exportProvenance: async () => {
                steps.push("export");
                return out.exported ?? true;
            },
            disposeWorkspace: (_a, mode) => {
                steps.push(`dispose:${mode}`);
                if (out.disposalError) return err<WorkspaceDisposal, WorkspaceError>(out.disposalError);
                return ok<WorkspaceDisposal, WorkspaceError>(out.disposal ?? { kind: "archived", path: ARCHIVE_PATH });
            },
            purgeAnalysis: (pool, analysisId) => {
                steps.push("purge");
                purged.push({ pool, analysisId });
                return out.purgeError ? errAsync(out.purgeError) : okAsync<AnalysisPurgeOutcome, DbError>(PURGED);
            },
            deleteAnalysis: () => {
                steps.push("delete-row");
                return ok<number, SqliteError>(out.rowsDeleted ?? 1);
            },
            listRecentAnalyses: () => ok<Analysis[], SqliteError>(out.remaining ?? []),
            openAnalysis: async (_ws, a) => {
                steps.push(`land:${a.id}`);
            },
            notify: (n) => {
                notices.push(n);
            },
        };
        return { seams, steps, notices, purged };
    }

    /** A scope stand-in recording only the quit the landing falls back to. */
    function scope(): { ws: Workspace; quits: () => number } {
        let quits = 0;
        const ws = {
            analysis: ANALYSIS,
            sessionId: null,
            workingDir: "/work",
            project: null,
            openDialog: () => {},
            closeDialog: () => {},
            openSession: () => {},
            quit: async () => {
                quits += 1;
            },
        } as unknown as Workspace;
        return { ws, quits: () => quits };
    }

    test("keeping the files: flush, export, dispose, purge, then the row — in that order", async () => {
        const l = ladder({ remaining: [SURVIVOR] });
        const w = scope();

        await deleteAnalysisWith(w.ws, ANALYSIS, "archive", l.seams);

        // The export lands BEFORE the disposal because it writes into the live workspace, and the row
        // goes LAST because it carries the only copy of the id the purge needs.
        expect(l.steps).toEqual(["flush", "export", "dispose:archive", "purge", "delete-row", `land:${SURVIVOR.id}`]);
        expect(l.purged).toEqual([{ pool: fakePool, analysisId: ANALYSIS.id }]);
        expect(l.notices.at(-1)?.kind).toBe("info");
        expect(l.notices.at(-1)?.text).toContain(ARCHIVE_PATH);
    });

    test("deleting the files: nothing is exported, and the purge still precedes the row", async () => {
        const l = ladder({ disposal: { kind: "deleted", path: "/work/.inflexa/analyses/alpha" } });
        const w = scope();

        await deleteAnalysisWith(w.ws, ANALYSIS, "delete", l.seams);

        // No export: the tree that would hold the document is the one being removed. The purge runs
        // anyway — the disposal mode governs the workspace tree, never the Postgres footprint.
        expect(l.steps).toEqual(["dispose:delete", "purge", "delete-row"]);
        expect(l.purged).toEqual([{ pool: fakePool, analysisId: ANALYSIS.id }]);
        expect(w.quits()).toBe(1);
    });

    test("a purge failure leaves the SQLite row standing and says nothing was lost", async () => {
        const l = ladder({ purgeError: pgErr });
        const w = scope();

        await deleteAnalysisWith(w.ws, ANALYSIS, "archive", l.seams);

        // Deleting the row anyway would convert a retryable failure into a permanent orphan: the id
        // that names the footprint would be gone, so no later run could reach it.
        expect(l.steps).toEqual(["flush", "export", "dispose:archive", "purge"]);
        expect(l.notices.at(-1)?.kind).toBe("error");
        expect(l.notices.at(-1)?.text).toContain("nothing was lost");
        // The archive already happened, and this is the last moment its path is known: a retry finds no
        // tree at the live location and truthfully reports the analysis had no files on disk, so a user
        // who never saw this notice would never learn the artifacts were moved, or where.
        expect(l.notices.at(-1)?.text).toContain(ARCHIVE_PATH);
        // The stage, not just the class. A toast is this flow's only channel and carries no `cause`, so
        // a notice naming `query_failed` alone would leave the user nothing to distinguish a refused id
        // from a ledger delete that dropped its connection — and nothing to act on but a re-run.
        expect(l.notices.at(-1)?.text).toContain(`${pgErr.type} at ${pgErr.op}`);
        expect(w.quits()).toBe(0);
    });

    test("a purge failure after a permanent deletion names no path, because nothing was kept", async () => {
        const l = ladder({ purgeError: pgErr, disposal: { kind: "deleted", path: "/work/.inflexa/analyses/alpha" } });
        const w = scope();

        await deleteAnalysisWith(w.ws, ANALYSIS, "delete", l.seams);

        expect(l.notices.at(-1)?.text).toContain("nothing was lost");
        expect(l.notices.at(-1)?.text).not.toContain("files are already at");
    });

    test("a failed disposal aborts before the purge is even attempted", async () => {
        const l = ladder({ disposalError: { type: "mutation_failed", op: "disposeWorkspace", cause: new Error("EACCES") } });
        const w = scope();

        await deleteAnalysisWith(w.ws, ANALYSIS, "archive", l.seams);

        expect(l.steps).toEqual(["flush", "export", "dispose:archive"]);
        expect(l.purged).toEqual([]);
        expect(l.notices.at(-1)?.text).toContain("NOT deleted");
    });

    test("without a booted runtime nothing is exported, disposed, purged, or deleted", async () => {
        const l = ladder({ runtime: null });
        const w = scope();

        await deleteAnalysisWith(w.ws, ANALYSIS, "archive", l.seams);

        expect(l.steps).toEqual([]);
        expect(l.notices).toHaveLength(1);
        expect(l.notices[0]?.kind).toBe("warn");
        expect(l.notices[0]?.text).toContain("harness is not running");
    });

    test("an export that fails does not abort, and says so in the deletion's own notice", async () => {
        const l = ladder({ exported: false });
        const w = scope();

        await deleteAnalysisWith(w.ws, ANALYSIS, "archive", l.seams);

        // Carrying on is the point: the user asked to delete the analysis, not to export provenance.
        expect(l.steps).toEqual(["flush", "export", "dispose:archive", "purge", "delete-row"]);
        // The export raises its own toast, but the outcome notice arrives milliseconds later and the
        // channel replaces what is showing — so the fact has to ride the notice the user will see.
        expect(l.notices.at(-1)?.kind).toBe("warn");
        expect(l.notices.at(-1)?.text).toContain('Deleted analysis "Alpha"');
        expect(l.notices.at(-1)?.text).toContain("provenance could not be exported");
    });

    test("an analysis that was never opened is deleted without anything being created", async () => {
        const root = mkdtempSync(join(tmpdir(), "inflexa-delete-absent-"));
        const workspace = join(root, ".inflexa", "analyses", "alpha");
        const l = ladder({ disposal: { kind: "absent" } });
        const w = scope();
        const seams: AnalysisDeleteSeams = {
            ...l.seams,
            hasWorkspaceOnDisk: () => existsSync(workspace),
            // Mirrors what the real export does on the way to writing: it `mkdir`s its destination.
            // That is precisely how a deletion could end up CREATING the tree it was asked to retire,
            // so the fake has to do it for the assertion below to mean anything.
            exportProvenance: async () => {
                l.steps.push("export");
                mkdirSync(workspace, { recursive: true });
                writeFileSync(join(workspace, "provenance.json"), "{}");
                return true;
            },
        };

        try {
            await deleteAnalysisWith(w.ws, ANALYSIS, "archive", seams);

            // Neither stage ran: there is nothing to preserve beside a tree that does not exist.
            expect(l.steps).toEqual(["dispose:archive", "purge", "delete-row"]);
            expect(existsSync(workspace)).toBe(false);
            // The row still goes, and the disposal's `absent` is what the user is told.
            expect(l.notices.at(-1)?.kind).toBe("info");
            expect(l.notices.at(-1)?.text).toContain("no files on disk");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a flush that could not run leaves the export caveated, not silent", async () => {
        const l = ladder({ flushed: false });
        const w = scope();

        await deleteAnalysisWith(w.ws, ANALYSIS, "archive", l.seams);

        // The document was still written — it is the session's tail that may be missing from it, which
        // is a different claim from "not exported" and must not be collapsed into it.
        expect(l.steps).toEqual(["flush", "export", "dispose:archive", "purge", "delete-row"]);
        expect(l.notices.at(-1)?.kind).toBe("warn");
        expect(l.notices.at(-1)?.text).toContain("may be missing this session's last activity");
    });

    test("the palette refuses before any confirmation when the harness is not booted", async () => {
        __resetNoticesForTest();
        let dialogs = 0;
        const ws = {
            analysis: ANALYSIS,
            sessionId: null,
            openDialog: () => {
                dialogs += 1;
            },
            closeDialog: () => {},
            quit: async () => {},
        } as unknown as Workspace;

        // Nothing in this process booted a runtime, so the command's own gate is what runs — spending
        // the user's name-typing confirmation on a delete the ladder would refuse is the point of it.
        await commands.find((c) => c.id === "analysis.delete")!.run(ws);

        expect(dialogs).toBe(0);
        expect(currentNotice()?.kind).toBe("warn");
        expect(currentNotice()?.text).toContain("harness is not running");
        __resetNoticesForTest();
    });
});
