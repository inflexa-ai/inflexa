import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { errAsync, ok, okAsync } from "neverthrow";

import { GLYPHS } from "../lib/design_system.ts";
import { __setClipboardWriterForTest } from "../lib/clipboard.ts";
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
    selectSwitchSession,
    switchSessionItems,
    type AnalysisDeleteOpts,
    type CommandId,
    type SessionOpts,
} from "./commands.tsx";
import type { ThreadList, ThreadSummary } from "../api/conversation.ts";
import { conversationSummary, threadListOf } from "../test_support/threads.ts";
import type { ClientOpts } from "../client/api.ts";
import type { Workspace } from "./contexts/workspace.ts";
import type { Notice } from "./theme.ts";
import type { ClientError } from "../client/api.ts";
import type { DeleteAnalysisResponse, WorkspaceDisposalMode } from "../api/analyses.ts";
import type { ApiError } from "../api/common.ts";
import type { Analysis } from "../types/analysis.ts";

// modelStatusLines reads the module-level boot + agentModels stores, so each test seeds them via the
// test hooks and the reset below keeps one test's seed from bleeding into the next (the same pairing
// sidebar.render.test.tsx uses for the rail's MODELS section).
afterEach(() => {
    __setAgentModelsForTest({ current: { conversation: "", sandbox: "", utility: "" }, efforts: null, pending: new Map() });
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

    test("ready: spells out the cliproxy connection and each agent's live model and effort", () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        __setAgentModelsForTest({
            current: { conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5", utility: "claude-sonnet-4-5" },
            efforts: { conversation: "high", sandbox: "medium", utility: "medium" },
            pending: new Map(),
        });
        const lines = modelStatusLines();
        expect(lines[0]).toContain("anthropic");
        expect(lines[0]).toContain("cliproxy (managed local proxy)");
        expect(lines[1]).toBe(`chat model: claude-opus-4-8 ${GLYPHS.middot} high`);
        expect(lines[2]).toBe(`sandbox model: claude-sonnet-4-5 ${GLYPHS.middot} medium`);
    });

    test("ready: a direct connection glosses the user-configured endpoint", () => {
        __setBootStateForTest({ phase: "ready", model: "deepseek-chat", connection: { provider: "deepseek", mode: "direct" } });
        __setAgentModelsForTest({
            current: { conversation: "deepseek-chat", sandbox: "deepseek-reasoner", utility: "deepseek-reasoner" },
            efforts: null,
            pending: new Map(),
        });
        expect(modelStatusLines()[0]).toContain("direct (user-configured endpoint)");
    });

    test("a scheduled switch renders as current → pending on the agent's line", () => {
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        __setAgentModelsForTest({
            current: { conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5", utility: "claude-sonnet-4-5" },
            efforts: null,
            pending: new Map([["sandbox", { model: "claude-haiku-4-5", effort: "low" }]]),
        });
        expect(modelStatusLines()[2]).toContain(`claude-sonnet-4-5 ${GLYPHS.arrowRight} claude-haiku-4-5 ${GLYPHS.middot} low (pending)`);
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

    // The copy is the one session command with no boot gate. Every sibling reads Postgres; this reads the
    // id the scope already holds, so gating it on a runtime would refuse an act that needs none — and the
    // id is most wanted exactly when something else is wrong with the harness.
    test("copying the session id needs a bound thread and nothing else", () => {
        for (const phase of [{ phase: "idle" }, { phase: "booting" }, { phase: "failed", message: "postgres unreachable" }] as const) {
            __setBootStateForTest(phase);
            expect(enabledOf("session.copy-id", BOUND)).toBe(true);
        }
        __setBootStateForTest({ phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } });
        expect(enabledOf("session.copy-id", scope(ANALYSIS, null))).toBe(false);
        // The id belongs to the session, not to the analysis, so an unbound analysis is no obstacle.
        expect(enabledOf("session.copy-id", scope(null, "thread-bound-1"))).toBe(true);
    });

    test("the copy hands over the FULL id and confirms it in the chip's own words", async () => {
        const copied: string[] = [];
        const restore = __setClipboardWriterForTest(async (text) => {
            copied.push(text);
        });
        try {
            const cmd = commands.find((c) => c.id === "session.copy-id")!;
            expect(cmd.category).toBe("Session");
            expect(cmd.title).toBe("Copy session id");

            await cmd.run(scope(ANALYSIS, "01988cdd-7f00-7abc-8def-0123456789ab"));

            // The whole id, never the four-digit handle the rail prints — the handle identifies a row on
            // screen, and the id is what a user pastes into a command.
            expect(copied).toEqual(["01988cdd-7f00-7abc-8def-0123456789ab"]);
            expect(currentNotice()?.text).toBe("Copied to clipboard");
        } finally {
            restore();
            __resetNoticesForTest();
        }
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

// The session flows (switch / rename / delete) and the in-place analysis open reach the server and the
// toast channel through `SessionOpts`, so every case here runs offline: the fakes resolve on the test's
// schedule, which is what makes the refusals, the degrades, and the interleaving of two rapid opens
// assertable at all.
describe("session flows", () => {
    // Only `id`/`name` are load-bearing (the flows pass the row through to `openSession`), so a partial
    // stand-in cast keeps the fixture flat.
    const ANALYSIS = { id: "a1", name: "Alpha", projectId: null } as unknown as Analysis;
    const serverErr: ClientError = { type: "http", status: 500, body: { error: "internal_error", message: "boom" } };
    const READY = { phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } } as const;

    /**
     * A live conversation by default: the tombstone (`archivedAt`) is what an archived row carries, and
     * every flow but restore only ever sees rows without one.
     */
    function threadRow(over: Partial<ThreadSummary> = {}): ThreadSummary {
        return conversationSummary({ id: "thread-1", resourceId: ANALYSIS.id, ...over });
    }

    /**
     * A workspace stand-in recording the two writes a session flow can make: dialogs and scope swaps.
     *
     * `swapTo` moves the open scope the way the user's own switch keys would. Each flow reads the scope
     * once, awaits the server, then acts — and nothing is modal across that await, so the switch keys stay
     * live. Driving the swap from inside a fake read is how a test lands in that window deterministically.
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

    /** Session options plus recorders for the notices raised and the snapshot pokes issued. */
    function makeOpts(over: Partial<SessionOpts> = {}): { opts: SessionOpts; notices: Notice[]; refreshed: string[] } {
        const notices: Notice[] = [];
        const refreshed: string[] = [];
        const base: SessionOpts = {
            ready: () => true,
            listThreads: () => okAsync(threadListOf([])),
            listReportChildren: () => okAsync(threadListOf([])),
            getThread: () => okAsync(null),
            updateTitle: () => okAsync(null),
            listThreadsWithArchived: () => okAsync(threadListOf([])),
            archiveThread: () => okAsync(undefined),
            unarchiveThread: () => okAsync(undefined),
            // The files stay by default: a case that is not about the files says so by leaving this alone.
            purgeThread: () => okAsync({ purged: [], pages: { kind: "kept" } }),
            chatBusy: () => false,
            resolveThreadId: async () => "thread-resolved",
            workingDirFor: () => "/work",
            refreshThread: (_analysisId, threadId) => {
                refreshed.push(threadId);
            },
            notify: (n) => {
                notices.push(n);
            },
        };
        return { opts: { ...base, ...over }, notices, refreshed };
    }

    test("switch refuses before boot reaches ready, speaking rather than no-op'ing, and lists nothing", async () => {
        // The palette hides the command pre-`ready`, but its leader chord dispatches by id and bypasses
        // that predicate — so this path IS reachable while the runtime is still booting.
        __setBootStateForTest({ phase: "booting" });
        let listings = 0;
        const t = makeOpts({
            listThreads: () => {
                listings += 1;
                return okAsync(threadListOf([]));
            },
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await openSwitchSession(w.ws, t.opts);

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
        const t = makeOpts();
        const w = sessionScope(ANALYSIS, "thread-1");

        await openSwitchSession(w.ws, t.opts);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("warn");
        expect(t.notices[0]?.text).toContain("did not start");
        expect(t.notices[0]?.text).not.toContain("booting");
    });

    test("a failed listing warns and still opens the picker — a degrade, never a crash", async () => {
        __setBootStateForTest(READY);
        const t = makeOpts({ listThreads: () => errAsync(serverErr) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await openSwitchSession(w.ws, t.opts);

        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("warn");
        // The picker still opens (on an empty list): the user keeps a working surface, and its empty
        // state is what tells them nothing could be listed.
        expect(w.dialogs()).toBe(1);
    });

    test("rename refuses BEFORE the prompt opens when the thread has no row yet", async () => {
        // The row is the first turn's job, so there is nothing to retitle until then — refusing up front
        // costs nothing, where refusing on submit spends the user's typing on a write that cannot land.
        const t = makeOpts({ getThread: () => okAsync(null) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await openRenameSession(w.ws, t.opts);

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
        const t = makeOpts({
            listThreads: () => {
                w.swapTo({ analysis: OTHER });
                return okAsync(threadListOf([threadRow()]));
            },
        });

        await openSwitchSession(w.ws, t.opts);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.text).toContain("Analysis changed");
    });

    test("rename refuses to open a prompt for the session the user has since left", async () => {
        // "Rename session" means the one in front of you. A prompt pre-filled from the conversation just
        // navigated away from would retitle THAT one under a heading claiming to be about this one.
        const w = sessionScope(ANALYSIS, "thread-1");
        const t = makeOpts({
            getThread: () => {
                w.swapTo({ sessionId: "thread-2" });
                return okAsync(threadRow());
            },
        });

        await openRenameSession(w.ws, t.opts);

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
        const t = makeOpts({
            getThread: () => {
                w.swapTo({ sessionId: "thread-2" });
                return okAsync(threadRow());
            },
            archiveThread: () => {
                archives += 1;
                return okAsync(undefined);
            },
        });

        await deleteSessionFlow(w.ws, t.opts);

        expect(w.dialogs()).toBe(0);
        expect(archives).toBe(0);
        expect(w.opened).toEqual([]); // nothing tombstoned, so nothing re-landed
        expect(t.notices[0]?.text).toContain("Session changed");
    });

    test("rename distinguishes a FAILED read from an absent row — no false claim about the user's data", async () => {
        // Both refuse, and both refuse before the prompt; the difference is what they assert. Collapsing
        // the read failure into the branch above would tell a user whose server blinked that they have
        // no saved conversation, and hand them a remedy ("send a message first") that cannot help.
        const t = makeOpts({ getThread: () => errAsync(serverErr) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await openRenameSession(w.ws, t.opts);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("error");
        expect(t.notices[0]?.text).toContain("Could not read");
        expect(t.notices[0]?.text).not.toContain("Send a message first");
    });

    test("rename opens the prompt on a live row, pre-filled from the thread title", async () => {
        const t = makeOpts({ getThread: () => okAsync(threadRow()) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await openRenameSession(w.ws, t.opts);

        expect(w.dialogs()).toBe(1);
        expect(t.notices).toEqual([]);
    });

    test("a rename whose row vanished between the prompt and the submit warns instead of reporting success", async () => {
        // The concurrent-delete backstop: `PATCH {T}` finds no row (404, read as `null`), so a silent
        // success would claim a title the sidebar will never show.
        const t = makeOpts({ updateTitle: () => okAsync(null) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await commitSessionRename(w.ws, ANALYSIS.id, "thread-1", "Variant burden sweep", t.opts);

        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("warn");
        expect(t.refreshed).toEqual([]); // nothing changed, so nothing to repaint
    });

    test("a committed rename pokes the open-thread snapshot, since the bound id never changed", async () => {
        const t = makeOpts({ updateTitle: (_analysisId, threadId, title) => okAsync(threadRow({ id: threadId, title })) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await commitSessionRename(w.ws, ANALYSIS.id, "thread-1", "  Variant burden sweep  ", t.opts);

        expect(t.notices[0]?.kind).toBe("info");
        expect(t.notices[0]?.text).toContain("Variant burden sweep"); // trimmed before it is written
        expect(t.refreshed).toEqual(["thread-1"]);
    });

    test("a rename that lands after the user swapped sessions reports success but does NOT repaint the rail", async () => {
        // The prompt closes on submit, so the palette is reachable again while the write is in flight.
        // Poking the snapshot for the renamed thread would then load it over the conversation the user
        // actually has open — the exact cross-thread repaint the snapshot's id check exists to stop.
        const t = makeOpts({ updateTitle: (_analysisId, threadId, title) => okAsync(threadRow({ id: threadId, title })) });
        const w = sessionScope(ANALYSIS, "thread-moved-on");

        await commitSessionRename(w.ws, ANALYSIS.id, "thread-1", "Variant burden sweep", t.opts);

        // The write DID land, so the user is told so.
        expect(t.notices[0]?.kind).toBe("info");
        expect(t.notices[0]?.text).toContain("Variant burden sweep");
        expect(t.refreshed).toEqual([]);
    });

    test("a rename write failure surfaces the error and leaves the rail alone", async () => {
        const t = makeOpts({ updateTitle: () => errAsync(serverErr) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await commitSessionRename(w.ws, ANALYSIS.id, "thread-1", "Variant burden sweep", t.opts);

        expect(t.notices[0]?.kind).toBe("error");
        expect(t.refreshed).toEqual([]);
    });

    test("delete says there is nothing to remove when the conversation has no saved row", async () => {
        // Confirming against a name we do not have would ask the user to type a fiction.
        const t = makeOpts({ getThread: () => okAsync(null) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await deleteSessionFlow(w.ws, t.opts);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("info");
        expect(t.notices[0]?.text).toContain("nothing to remove");
    });

    test("delete distinguishes a FAILED read from an absent row, and says nothing was removed", async () => {
        const t = makeOpts({ getThread: () => errAsync(serverErr) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await deleteSessionFlow(w.ws, t.opts);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("error");
        expect(t.notices[0]?.text).toContain("Could not read");
        expect(t.notices[0]?.text).not.toContain("nothing saved yet");
    });

    test("a confirmed delete re-lands the chat on the analysis's surviving thread", async () => {
        const t = makeOpts({ resolveThreadId: async () => "thread-survivor" });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionDelete(w.ws, ANALYSIS, "thread-1", t.opts);

        expect(t.notices[0]?.kind).toBe("info");
        // The write is a tombstone, so the notice reports the reach it actually has. Claiming a
        // deletion would be the one thing this flow cannot back up — the transcript stays on the server.
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
        const t = makeOpts({ resolveThreadId: async () => (await gate, "thread-survivor") });
        const w = sessionScope(ANALYSIS, "thread-1");

        const flow = confirmSessionDelete(w.ws, ANALYSIS, "thread-1", t.opts);
        await Promise.resolve(); // let the delete settle and the unbind land

        expect(w.opened).toEqual([{ threadId: null, analysisId: ANALYSIS.id }]);

        release();
        await flow;
        expect(w.opened.at(-1)).toEqual({ threadId: "thread-survivor", analysisId: ANALYSIS.id });
    });

    test("a failed delete surfaces the error and leaves the user where they were", async () => {
        const t = makeOpts({ archiveThread: () => errAsync(serverErr) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionDelete(w.ws, ANALYSIS, "thread-1", t.opts);

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
        const t = makeOpts({
            resolveThreadId: async () => "thread-survivor",
            purgeThread: (_analysisId, threadId) => {
                purged.push(threadId);
                return okAsync({ purged: [threadId], pages: { kind: "kept" } });
            },
            archiveThread: () => {
                archives += 1;
                return okAsync(undefined);
            },
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionPurge(w.ws, ANALYSIS, "thread-1", "keep", t.opts);

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
        const t = makeOpts({
            getThread: () => {
                w.swapTo({ sessionId: "thread-2" });
                return okAsync(threadRow());
            },
            purgeThread: () => {
                purges += 1;
                return okAsync({ purged: [], pages: { kind: "kept" } });
            },
        });

        await purgeSessionFlow(w.ws, t.opts);

        expect(w.dialogs()).toBe(0);
        expect(purges).toBe(0);
        expect(w.opened).toEqual([]); // nothing erased, so nothing re-landed
        expect(t.notices[0]?.text).toContain("Session changed");
    });

    test("delete says there is nothing to erase when the conversation has no saved row", async () => {
        // Confirming against a name we do not have would ask the user to type a fiction — and for the
        // one action where a mistyped confirmation is unrecoverable.
        const t = makeOpts({ getThread: () => okAsync(null) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await purgeSessionFlow(w.ws, t.opts);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("info");
        expect(t.notices[0]?.text).toContain("nothing to delete");
    });

    test("delete distinguishes a FAILED read from an absent row, and says nothing was deleted", async () => {
        const t = makeOpts({ getThread: () => errAsync(serverErr) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await purgeSessionFlow(w.ws, t.opts);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("error");
        expect(t.notices[0]?.text).toContain("Could not read");
        expect(t.notices[0]?.text).toContain("nothing was deleted");
    });

    test("delete refuses while a turn is streaming into the conversation, before reading or confirming", async () => {
        // The purge is unrecoverable and a turn write has no foreign key to the thread row: a turn
        // committing after it lands messages under a `thread_id` that resolves to no analysis, which no
        // later reclamation can reach. The harness states this precondition and cannot enforce it, and
        // the server leaves it to the client, so the refusal has to be here — and ahead of the read, so
        // the user never types a name for an action that was never going to run.
        let reads = 0;
        let purges = 0;
        const t = makeOpts({
            chatBusy: () => true,
            getThread: () => {
                reads += 1;
                return okAsync(threadRow());
            },
            purgeThread: () => {
                purges += 1;
                return okAsync({ purged: [], pages: { kind: "kept" } });
            },
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await purgeSessionFlow(w.ws, t.opts);

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
        const t = makeOpts({ chatBusy: () => true, getThread: () => okAsync(threadRow()) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await deleteSessionFlow(w.ws, t.opts);

        expect(w.dialogs()).toBe(1);
        expect(t.notices).toEqual([]);
    });

    test("remove and delete both SPEAK when the harness is down, rather than swallowing the keystroke", async () => {
        // Same bypass the pre-`ready` refusals above cover: the palette gates both commands on a booted
        // harness, and the leader chord dispatches by id without consulting `enabled`. A silent return
        // there reads to the user as a dead key on a command the palette lists.
        for (const flow of [deleteSessionFlow, purgeSessionFlow]) {
            const t = makeOpts({ ready: () => false, getThread: () => okAsync(threadRow()) });
            const w = sessionScope(ANALYSIS, "thread-1");

            await flow(w.ws, t.opts);

            expect(t.notices).toHaveLength(1);
            expect(t.notices[0]!.text).toContain("harness is not running");
            // Nothing was read and nothing was confirmed: the refusal is the whole of what happened.
            expect(w.dialogs()).toBe(0);
        }
    });

    test("delete opens the confirmation on a live row, naming the conversation to type back", async () => {
        const t = makeOpts({ getThread: () => okAsync(threadRow()) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await purgeSessionFlow(w.ws, t.opts);

        expect(w.dialogs()).toBe(1);
        expect(t.notices).toEqual([]);
    });

    test("a failed delete surfaces the error and leaves the user on the conversation", async () => {
        const t = makeOpts({ purgeThread: () => errAsync(serverErr) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionPurge(w.ws, ANALYSIS, "thread-1", "keep", t.opts);

        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("error");
        expect(w.opened).toEqual([]); // the thread is still there, so nothing is re-landed
    });

    // The page folder of a report session takes the name of its thread id, and the erase is the only
    // source for the set of ids it took — after it, no listing names them. The server removes the
    // folders after the erase (`POST {T}/purge` with `files`) and reports what became of them. These
    // cases pin the client half: what the user is asked, when, what the flow sends, and what the notice
    // says for each fate.
    test("the file question is asked on every delete: nothing is erased before it", async () => {
        // The erase names the threads it took, and it names them only after it runs. The question must
        // therefore come before the erase, which is the one write past the point of no return.
        let purges = 0;
        const t = makeOpts({
            getThread: () => okAsync(threadRow()),
            purgeThread: () => {
                purges += 1;
                return okAsync({ purged: [], pages: { kind: "kept" } });
            },
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await purgeSessionFlow(w.ws, t.opts);

        expect(w.dialogs()).toBe(1);
        expect(purges).toBe(0);
    });

    test("the accept and the decline each reach the server as the file choice of the purge", async () => {
        // The rows go either way — the choice governs the files alone, and the server acts on it.
        const sent: { threadId: string; files: "keep" | "remove" }[] = [];
        const t = makeOpts({
            purgeThread: (_analysisId, threadId, files) => {
                sent.push({ threadId, files });
                return okAsync({ purged: [threadId], pages: files === "keep" ? { kind: "kept" } : { kind: "removed" } });
            },
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionPurge(w.ws, ANALYSIS, "thread-1", "remove", t.opts);
        await confirmSessionPurge(w.ws, ANALYSIS, "thread-1", "keep", t.opts);

        expect(sent).toEqual([
            { threadId: "thread-1", files: "remove" },
            { threadId: "thread-1", files: "keep" },
        ]);
    });

    test("a removal that left nothing reports that nothing remains, and claims no work it cannot see", async () => {
        // The common delete is a conversation that owns no page, and a forced removal cannot report
        // whether a folder was there. Thus the notice must claim no work that never ran.
        const t = makeOpts({ purgeThread: () => okAsync({ purged: ["thread-1"], pages: { kind: "removed" } }) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionPurge(w.ws, ANALYSIS, "thread-1", "remove", t.opts);

        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("info");
        expect(t.notices[0]?.text).toContain("transcript is gone");
        expect(t.notices[0]?.text).toContain("no report page remains");
        expect(t.notices[0]?.text).not.toContain("are removed");
        expect(t.notices[0]?.text).not.toContain("stayed");
    });

    test("the decline says no report page was removed", async () => {
        const t = makeOpts({ purgeThread: () => okAsync({ purged: ["thread-1", "report-a"], pages: { kind: "kept" } }) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionPurge(w.ws, ANALYSIS, "thread-1", "keep", t.opts);

        expect(t.notices[0]?.kind).toBe("info");
        expect(t.notices[0]?.text).toContain("no report page was removed");
    });

    test("a workspace the server cannot locate warns, and it gives the cause", async () => {
        // A tree can be there, and the server never named it. The user has no folder to act on, thus the
        // cause is the whole of what the notice can give them.
        const t = makeOpts({ purgeThread: () => okAsync({ purged: ["thread-1", "report-a"], pages: { kind: "unlocatable" } }) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionPurge(w.ws, ANALYSIS, "thread-1", "remove", t.opts);

        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("warn");
        expect(t.notices[0]?.text).toContain("its report pages stayed");
        expect(t.notices[0]?.text).toContain("workspace did not resolve");
    });

    test("a failed erase leaves the user on the conversation, even where they asked to remove the files", async () => {
        // The rows survive a failed erase, thus each page is still reachable from them.
        const t = makeOpts({ purgeThread: () => errAsync(serverErr) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionPurge(w.ws, ANALYSIS, "thread-1", "remove", t.opts);

        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("error");
        expect(w.opened).toEqual([]);
    });

    test("a page folder that resisted removal keeps the delete a success and is named in the notice", async () => {
        // The rows are gone and nothing restores them, so a file left behind cannot make this a failed
        // delete. Naming the folder is the whole remedy the user has: after the erase, no surface can
        // name it for them.
        const stubborn = "/root/report-sessions/report-b";
        const t = makeOpts({ purgeThread: () => okAsync({ purged: ["thread-1", "report-b"], pages: { kind: "stayed", dirs: [stubborn] } }) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionPurge(w.ws, ANALYSIS, "thread-1", "remove", t.opts);

        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("warn");
        expect(t.notices[0]?.text).toContain("transcript is gone");
        expect(t.notices[0]?.text).toContain(stubborn);
        // Unbound and re-landed exactly as a clean delete is — a stayed folder changes nothing here.
        expect(w.opened).toEqual([
            { threadId: null, analysisId: ANALYSIS.id },
            { threadId: "thread-resolved", analysisId: ANALYSIS.id },
        ]);
    });

    test("a page that stayed with no name says that nothing can name it, and does not blame the workspace", async () => {
        const t = makeOpts({ purgeThread: () => okAsync({ purged: ["thread-1"], pages: { kind: "stayed", dirs: [] } }) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await confirmSessionPurge(w.ws, ANALYSIS, "thread-1", "remove", t.opts);

        expect(t.notices[0]?.kind).toBe("warn");
        expect(t.notices[0]?.text).toContain("nothing can name them");
        expect(t.notices[0]?.text).not.toContain("workspace");
    });

    // The moment a removal stamped the tombstone. Distinct from the fixture's activity clock, which the
    // archive deliberately leaves alone, so an assertion can tell the two stamps apart.
    const ARCHIVED_AT = "2026-07-09T09:30:00.000Z";

    test("restore refuses before boot reaches ready, speaking rather than no-op'ing, and lists nothing", async () => {
        // Reachable pre-`ready` for the same reason the switch picker is: the leader chord dispatches by
        // id and bypasses the palette's `enabled` predicate.
        __setBootStateForTest({ phase: "booting" });
        let listings = 0;
        const t = makeOpts({
            listThreadsWithArchived: () => {
                listings += 1;
                return okAsync(threadListOf([]));
            },
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await openRestoreSession(w.ws, t.opts);

        expect(listings).toBe(0);
        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("info");
        expect(t.notices[0]?.text).toContain("booting");
    });

    test("restore on a FAILED boot says the harness did not start, not that it is still booting", async () => {
        __setBootStateForTest({ phase: "failed", message: "postgres unreachable" });
        const t = makeOpts();
        const w = sessionScope(ANALYSIS, "thread-1");

        await openRestoreSession(w.ws, t.opts);

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
        const t = makeOpts({
            listThreadsWithArchived: () => {
                w.swapTo({ analysis: OTHER });
                return okAsync(threadListOf([threadRow({ archivedAt: ARCHIVED_AT })]));
            },
        });

        await openRestoreSession(w.ws, t.opts);

        expect(w.dialogs()).toBe(0);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.text).toContain("Analysis changed");
    });

    test("a failed archived listing warns and opens NO picker, so no empty state claims nothing was archived", async () => {
        __setBootStateForTest(READY);
        const t = makeOpts({ listThreadsWithArchived: () => errAsync(serverErr) });
        const w = sessionScope(ANALYSIS, "thread-1");

        await openRestoreSession(w.ws, t.opts);

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
        const pages: ThreadList[] = [
            { threads: [threadRow({ id: "live-1" })], total: 2, page: 0, perPage: 1, hasMore: true },
            { threads: [threadRow({ id: "archived-1", archivedAt: ARCHIVED_AT })], total: 2, page: 1, perPage: 1, hasMore: false },
        ];
        const asked: number[] = [];
        const t = makeOpts({
            listThreadsWithArchived: (_analysisId, page) => {
                asked.push(page);
                return okAsync(pages[page]!);
            },
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await openRestoreSession(w.ws, t.opts);

        expect(asked).toEqual([0, 1]);
        expect(w.dialogs()).toBe(1);
        expect(t.notices).toEqual([]);
    });

    test("restore stops walking and says the listing is partial rather than presenting it as complete", async () => {
        // A server that never stops reporting more must not spin the picker forever, and the bounded walk
        // it gets instead must not then pass its partial set off as the whole set.
        __setBootStateForTest(READY);
        let asked = 0;
        const t = makeOpts({
            listThreadsWithArchived: () => {
                asked += 1;
                return okAsync({ threads: [threadRow({ archivedAt: ARCHIVED_AT })], total: 9999, page: 0, perPage: 1, hasMore: true });
            },
        });
        const w = sessionScope(ANALYSIS, "thread-1");

        await openRestoreSession(w.ws, t.opts);

        expect(asked).toBeLessThan(100); // bounded, not spinning
        expect(w.dialogs()).toBe(1); // what WAS found is still offered
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("warn");
        expect(t.notices[0]?.text).toContain("not listed");
    });

    test("a restore lifts the chosen conversation's tombstone and names it in the notice", async () => {
        const restored: string[] = [];
        const t = makeOpts({
            unarchiveThread: (_analysisId, threadId) => {
                restored.push(threadId);
                return okAsync(undefined);
            },
        });

        await commitSessionRestore(ANALYSIS.id, threadRow({ id: "thread-archived", title: "Variant burden sweep", archivedAt: ARCHIVED_AT }), t.opts);

        expect(restored).toEqual(["thread-archived"]);
        expect(t.notices[0]?.kind).toBe("info");
        expect(t.notices[0]?.text).toContain("Variant burden sweep");
    });

    test("a failed restore surfaces the error rather than claiming the conversation is back", async () => {
        const t = makeOpts({ unarchiveThread: () => errAsync(serverErr) });

        await commitSessionRestore(ANALYSIS.id, threadRow({ title: "Variant burden sweep", archivedAt: ARCHIVED_AT }), t.opts);

        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("error");
        // The thread is still archived, so the one claim this outcome cannot make is that it is listing
        // again.
        expect(t.notices[0]?.text).not.toContain("appears in this analysis again");
    });

    test("two rapid opens: the one STARTED last wins, even when the older listing resolves last", async () => {
        // Both resolutions are server round-trips; without the generation token the slower (older) one
        // would land last and drop the user back on the analysis they just moved off.
        const OTHER = { id: "a2", name: "Bravo", projectId: null } as unknown as Analysis;
        let releaseSlow!: () => void;
        const gate = new Promise<void>((r) => {
            releaseSlow = r;
        });
        const slow = makeOpts({ resolveThreadId: async () => gate.then(() => "thread-alpha") });
        const fast = makeOpts({ resolveThreadId: async () => "thread-bravo" });
        const w = sessionScope(ANALYSIS, null);

        const stale = openAnalysis(w.ws, ANALYSIS, slow.opts); // parks on its gate
        await openAnalysis(w.ws, OTHER, fast.opts); // starts later, settles first

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
        const t = makeOpts();
        const w = recordingScope(ANALYSIS, "thread-current");

        newSessionFlow(w.ws, t.opts);

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
        const t = makeOpts();
        const w = recordingScope(ANALYSIS, null);

        newSessionFlow(w.ws, t.opts);
        newSessionFlow(w.ws, t.opts);

        expect(w.opened).toHaveLength(2);
        expect(w.opened[0]?.threadId).not.toBe(w.opened[1]?.threadId);
    });

    test("New session dispatched by id before ready speaks the refusal and swaps nothing", () => {
        // The palette hides the command pre-`ready`, but a by-id dispatch skips `enabled`, so the body
        // carries the same phase refusal the switch picker does — warn on the terminal `failed`, an
        // in-progress notice on every other non-ready phase.
        __setBootStateForTest({ phase: "failed", message: "postgres unreachable" });
        const failed = makeOpts();
        const wf = recordingScope(ANALYSIS, "thread-1");

        newSessionFlow(wf.ws, failed.opts);

        expect(wf.opened).toEqual([]);
        expect(failed.notices).toHaveLength(1);
        expect(failed.notices[0]?.kind).toBe("warn");
        expect(failed.notices[0]?.text).toContain("did not start");
        expect(failed.notices[0]?.text).not.toContain("booting");

        __setBootStateForTest({ phase: "booting" });
        const booting = makeOpts();
        const wb = recordingScope(ANALYSIS, "thread-1");

        newSessionFlow(wb.ws, booting.opts);

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
        const first = threadRow({ id: "thread-newest", title: "Newest" });
        const second = threadRow({ id: "thread-older", title: "Older" });

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
        const t = makeOpts();
        const w = recordingScope(ANALYSIS, "thread-current");
        // The sentinel is whatever value the pinned row carries — the test names it the way a pick does.
        // `switchSessionItems` always includes that one pinned row, so this find never misses.
        const sentinel = switchSessionItems([]).find((i) => i.pinned)!.value;

        selectSwitchSession(w.ws, sentinel, ANALYSIS, t.opts);

        expect(w.closes()).toBe(1);
        expect(w.opened).toHaveLength(1);
        expect(w.opened[0]?.analysisId).toBe(ANALYSIS.id);
        expect(w.opened[0]?.threadId).toBeTruthy();
        expect(w.opened[0]?.threadId).not.toBe("thread-current");
    });

    test("selecting a thread row closes the dialog and swaps onto that thread", () => {
        __setBootStateForTest(READY);
        const t = makeOpts();
        const w = recordingScope(ANALYSIS, "thread-current");
        const row = threadRow({ id: "thread-picked" });

        selectSwitchSession(w.ws, row, ANALYSIS, t.opts);

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

// The export runs in the server (its on-disk ordering is pinned by `modules/prov/export.test.ts`). The
// palette maps the answer of the route to its notice, and to the boolean that the delete ladder reads.
describe("palette provenance export", () => {
    const ANALYSIS = { id: "a1", name: "Alpha", slug: "alpha", anchorId: "anchor-1", projectId: null } as unknown as Analysis;

    beforeEach(() => __resetNoticesForTest());
    afterEach(() => __resetNoticesForTest());

    /** A client whose server answers each request with `status` and `body`, recording the URL and the JSON body of each request. */
    function answering(status: number, body: unknown, seen: { url: string; body: unknown }[]): ClientOpts {
        return {
            discover: () => ok({ baseUrl: "http://server.test", token: "t" }),
            fetch: async (url, init) => {
                seen.push({ url, body: JSON.parse(String(init.body)) });
                return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
            },
        };
    }

    test("a refused export resolves false and notifies the cause that the server names", async () => {
        const opts = answering(500, { error: "internal_error", message: "Signing failed (keypair_race_lost) — provenance is never exported unsigned." }, []);

        // The delete flow reads this to caveat its own outcome notice, so an unwritten export must never
        // report success back to a caller exporting on the user's behalf.
        expect(await exportProvenanceToFile(ANALYSIS, "json", opts)).toBe(false);
        expect(currentNotice()?.kind).toBe("error");
        expect(currentNotice()?.text).toContain("never exported unsigned");
    });

    test("a landed export sends the PROV format of the route and notifies the path", async () => {
        const seen: { url: string; body: unknown }[] = [];

        expect(await exportProvenanceToFile(ANALYSIS, "provn", answering(200, { path: "/w/provenance.provn" }, seen))).toBe(true);
        expect(seen).toEqual([{ url: "http://server.test/api/v1/analyses/a1/provenance/export", body: { format: "prov-n" } }]);
        expect(currentNotice()).toEqual({ kind: "info", text: "Wrote provn provenance to /w/provenance.provn" });
    });
});

// The ordered delete runs in the server (`DELETE {A}`), and `server/routes/analyses.test.ts` asserts its
// order. The client half is the request, the outcome notice, and the landing, and these cases assert that.
describe("analysis delete (client)", () => {
    const ANALYSIS = { id: "a1", name: "Alpha", slug: "alpha", anchorId: "anchor-1", projectId: null } as unknown as Analysis;
    const SURVIVOR = { id: "a2", name: "Beta", slug: "beta", anchorId: "anchor-1", projectId: null } as unknown as Analysis;
    const ARCHIVE_PATH = "/work/.inflexa/analyses_archived/alpha";

    /** A server error body, as the client gives it. */
    function httpError(status: number, error: ApiError["error"], message: string): ClientError {
        return { type: "http", status, body: { error, message } };
    }

    function flow(out: { response?: DeleteAnalysisResponse; error?: ClientError; next?: Analysis | null } = {}): {
        opts: AnalysisDeleteOpts;
        requests: { analysisId: string; workspace: WorkspaceDisposalMode }[];
        landed: string[];
        notices: Notice[];
    } {
        const requests: { analysisId: string; workspace: WorkspaceDisposalMode }[] = [];
        const landed: string[] = [];
        const notices: Notice[] = [];
        const opts: AnalysisDeleteOpts = {
            deleteAnalysis: (analysisId, workspace) => {
                requests.push({ analysisId, workspace });
                return out.error
                    ? errAsync(out.error)
                    : okAsync(out.response ?? { deleted: true, workspace: { kind: "archived", path: ARCHIVE_PATH }, export: "written" });
            },
            nextAnalysis: async () => (out.next === undefined ? SURVIVOR : out.next),
            openAnalysis: async (_ws, a) => {
                landed.push(a.id);
            },
            notify: (n) => {
                notices.push(n);
            },
        };
        return { opts, requests, landed, notices };
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

    test("keeping the files: one `keep` delete, the archive path in the notice, then the landing", async () => {
        const f = flow();
        const w = scope();

        await deleteAnalysisWith(w.ws, ANALYSIS, "archive", f.opts);

        expect(f.requests).toEqual([{ analysisId: ANALYSIS.id, workspace: "keep" }]);
        expect(f.notices.at(-1)?.kind).toBe("info");
        expect(f.notices.at(-1)?.text).toContain(ARCHIVE_PATH);
        expect(f.landed).toEqual([SURVIVOR.id]);
    });

    test("deleting the files with no analysis left quits", async () => {
        const f = flow({ response: { deleted: true, workspace: { kind: "deleted", path: "/work/.inflexa/analyses/alpha" }, export: "none" }, next: null });
        const w = scope();

        await deleteAnalysisWith(w.ws, ANALYSIS, "delete", f.opts);

        expect(f.requests).toEqual([{ analysisId: ANALYSIS.id, workspace: "delete" }]);
        expect(f.notices.at(-1)?.text).toContain("files deleted");
        expect(w.quits()).toBe(1);
    });

    test("a refusal of the server lands nowhere, and its message reaches the user", async () => {
        const f = flow({ error: httpError(409, "busy", "Cannot delete while a run is in flight.") });
        const w = scope();

        await deleteAnalysisWith(w.ws, ANALYSIS, "archive", f.opts);

        expect(f.notices).toEqual([{ kind: "warn", text: "Cannot delete while a run is in flight." }]);
        expect(f.landed).toEqual([]);
        expect(w.quits()).toBe(0);
    });

    test("a failed purge says that nothing was lost, as the server words it", async () => {
        const message = `Could not reclaim this analysis's stored conversations and run history (query_failed at purgeAnalysis) — the analysis was NOT deleted, so nothing was lost. Its files are already at ${ARCHIVE_PATH}. Try the delete again.`;
        const f = flow({ error: httpError(500, "internal_error", message) });

        await deleteAnalysisWith(scope().ws, ANALYSIS, "archive", f.opts);

        expect(f.notices).toEqual([{ kind: "error", text: message }]);
    });

    test("a server whose runtime is not ready gets the harness notice", async () => {
        const f = flow({ error: httpError(503, "unavailable", "The harness runtime is still starting.") });

        await deleteAnalysisWith(scope().ws, ANALYSIS, "archive", f.opts);

        expect(f.notices.at(-1)?.kind).toBe("warn");
        expect(f.notices.at(-1)?.text).toContain("harness is not running");
    });

    test("a failed or unflushed export rides the outcome notice of the delete", async () => {
        const failed = flow({ response: { deleted: true, workspace: { kind: "archived", path: ARCHIVE_PATH }, export: "failed" } });
        await deleteAnalysisWith(scope().ws, ANALYSIS, "archive", failed.opts);
        expect(failed.notices.at(-1)?.kind).toBe("warn");
        expect(failed.notices.at(-1)?.text).toContain('Deleted analysis "Alpha"');
        expect(failed.notices.at(-1)?.text).toContain("provenance could not be exported");

        const unflushed = flow({ response: { deleted: true, workspace: { kind: "archived", path: ARCHIVE_PATH }, export: "written_unflushed" } });
        await deleteAnalysisWith(scope().ws, ANALYSIS, "archive", unflushed.opts);
        expect(unflushed.notices.at(-1)?.text).toContain("may be missing this session's last activity");
    });

    test("an analysis with no folder on disk says so", async () => {
        const f = flow({ response: { deleted: true, workspace: { kind: "absent" }, export: "none" } });

        await deleteAnalysisWith(scope().ws, ANALYSIS, "archive", f.opts);

        expect(f.notices.at(-1)?.kind).toBe("info");
        expect(f.notices.at(-1)?.text).toContain("no files on disk");
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

        // The boot store is idle in this process, so the command's own gate is what runs — spending the
        // user's name-typing confirmation on a delete the server would refuse is the point of it.
        await commands.find((c) => c.id === "analysis.delete")!.run(ws);

        expect(dialogs).toBe(0);
        expect(currentNotice()?.kind).toBe("warn");
        expect(currentNotice()?.text).toContain("harness is not running");
        __resetNoticesForTest();
    });
});
