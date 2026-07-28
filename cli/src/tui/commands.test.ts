import { afterEach, describe, expect, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import type { DbError, Pool, Thread, ThreadPage } from "@inflexa-ai/harness";

import { GLYPHS } from "../lib/design_system.ts";
import { __setAgentModelsForTest, __setBootStateForTest } from "./hooks/boot.ts";
import {
    commands,
    commitSessionRename,
    confirmSessionDelete,
    deleteSessionFlow,
    modelStatusLines,
    openAnalysis,
    openRenameSession,
    openSwitchSession,
    type CommandId,
    type SessionSeams,
} from "./commands.tsx";
import type { Workspace } from "./contexts/workspace.ts";
import type { Notice } from "./theme.ts";
import type { HarnessRuntime } from "../modules/harness/runtime.ts";
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

// The three session commands read the module-level boot store and the workspace scope. Thread metadata
// lives only in Postgres, so before `ready` there is nothing to list, retitle, or remove; rename and
// delete additionally need a bound thread to act on. These drive the registry's own `enabled`
// predicates rather than a hand-rolled copy, so a re-wired gate fails here.
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

    test("all three are unavailable before boot reaches ready, even with a bound thread", () => {
        for (const phase of [{ phase: "idle" }, { phase: "booting" }, { phase: "failed", message: "postgres unreachable" }] as const) {
            __setBootStateForTest(phase);
            expect(enabledOf("session.switch", BOUND)).toBe(false);
            expect(enabledOf("session.rename", BOUND)).toBe(false);
            expect(enabledOf("session.delete", BOUND)).toBe(false);
        }
    });

    test("ready with no thread bound yet: switching is offered, rename and delete are not", () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        const unbound = scope(ANALYSIS, null);
        // Switching is how the user reaches an existing thread while the scope is still unbound.
        expect(enabledOf("session.switch", unbound)).toBe(true);
        expect(enabledOf("session.rename", unbound)).toBe(false);
        expect(enabledOf("session.delete", unbound)).toBe(false);
    });

    test("ready with a bound thread offers all three", () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        expect(enabledOf("session.switch", BOUND)).toBe(true);
        expect(enabledOf("session.rename", BOUND)).toBe(true);
        expect(enabledOf("session.delete", BOUND)).toBe(true);
    });

    test("no analysis in scope: the analysis-scoped session commands stay unavailable", () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        const noAnalysis = scope(null, "thread-bound-1");
        expect(enabledOf("session.switch", noAnalysis)).toBe(false);
        expect(enabledOf("session.delete", noAnalysis)).toBe(false);
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
            createdAt: new Date("2026-07-08T00:00:00.000Z"),
            updatedAt: new Date("2026-07-08T01:00:00.000Z"),
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
            getThread: () => okAsync(null),
            updateTitle: () => okAsync(null),
            deleteThread: () => okAsync<void, DbError>(undefined),
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
        let deletes = 0;
        const t = makeSeams({
            getThread: () => {
                w.swapTo({ sessionId: "thread-2" });
                return okAsync(threadRow());
            },
            deleteThread: () => {
                deletes += 1;
                return okAsync<void, DbError>(undefined);
            },
        });

        await deleteSessionFlow(w.ws, t.seams);

        expect(w.dialogs()).toBe(0);
        expect(deletes).toBe(0);
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
        const t = makeSeams({ deleteThread: () => errAsync(dbErr) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionDelete(w.ws, fakePool, ANALYSIS, "thread-1", t.seams);

        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("error");
        expect(w.opened).toEqual([]); // the thread still lists, so nothing is re-landed
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
});

// The panel's restore affordance is exposed BOTH ways — a chord and a palette command — mirroring how
// the sidebar toggle is. A user who dismissed the panel and does not recall the chord needs the
// palette entry, which is precisely why it is restore-only rather than a second toggle: a toggle
// there could hide the panel a second time and read as the command having done nothing.
describe("run-panel palette command", () => {
    test("restore is reachable from the palette, in the View category", () => {
        const cmd = commands.find((c) => c.id === "view.run-panel");
        expect(cmd).toBeDefined();
        expect(cmd!.category).toBe("View");
        // Discoverable by what a user would actually type after losing the panel.
        expect(`${cmd!.title} ${cmd!.description}`.toLowerCase()).toContain("run panel");
    });

    test("the command is restore-only, not a second toggle", () => {
        const cmd = commands.find((c) => c.id === "view.run-panel")!;
        // Behaviour is asserted in run_panel.test.ts, where an active run can be seeded; what matters
        // here is that the palette entry calls the restore, never the toggle — a toggle in the palette
        // could hide the panel a second time and read as the command having done nothing.
        expect(cmd.run.toString()).toContain("restoreRunPanel");
    });
});
