import { createSignal, Show, type JSX } from "solid-js";
import { randomUUIDv7 } from "bun";
import { sep } from "node:path";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
// Type-only — erased at compile time, so it does NOT pull tsprov/verify into the TUI's startup path.
import type { BuiltinProvFormat } from "@inflexa-ai/tsprov";
import type { VerifyResult } from "../types/prov.ts";

import { PromptDialog } from "./components/dialog/prompt_dialog.tsx";
import { ResultsDialog } from "./components/dialog/results_dialog.tsx";
import { SelectDialog } from "./components/dialog/select_dialog.tsx";
import type { SelectItem } from "./components/list_core.tsx";
import { PlanStepDetailDialog } from "./components/dialog/plan_step_detail_dialog.tsx";
import { RunDetailDialog } from "./components/dialog/run_detail_dialog.tsx";
import { FilePicker } from "./components/dialog/file_picker.tsx";
import { ConfigApp } from "./app_config.tsx";
import { DesignGallery } from "./layout/design_gallery.tsx";
import { setTheme, theme, type Notice } from "./theme.ts";
import { notify } from "./hooks/notice.ts";
import { FailedFlightDialog } from "./components/dialog/failed_flight_dialog.tsx";
import { storeFlightLines } from "./hooks/sandbox_gate.tsx";

import { agentModels, bootState, refreshAgentModels, type BootState } from "./hooks/boot.ts";
import { refreshOpenThread, resolveThreadId } from "./hooks/thread.ts";
import { latestPlanCard, sessionOpenables, type SessionOpenable } from "./hooks/conversation.ts";
import { openArtifact } from "./hooks/artifacts.ts";
import { describeClientError, DEFAULT_CLIENT_OPTS, type ClientError, type ClientOpts } from "../client/api.ts";
import { resolveArtifacts } from "../client/artifacts.ts";
import { createProvenanceExport, fetchProvenanceVerification } from "../client/provenance.ts";
import { gatedForceReprofile } from "./hooks/profile_parity.ts";
import { fetchRun, fetchRuns } from "../client/runs.ts";
import type { RunSummary } from "../api/runs.ts";
import { absTime, absTimeShort, idTail, refreshSidebarData, shortRunName, shortSessionId } from "./hooks/sidebar_live.ts";
import { restoreActivityPanel } from "./hooks/activity_panel.ts";
import { chatStatus } from "./hooks/status.ts";
import { KEYS, chordLabel, keybindLabel, type Chord } from "./keymap.ts";
import { useWorkspace, type Workspace } from "./contexts/workspace.ts";
import { GLYPHS, themes, themeIds, type ThemeId } from "../lib/design_system.ts";
import { AGENT_EFFORTS, readConfig, writeConfig } from "../lib/config.ts";
import { statResult } from "../lib/fs.ts";
import { str256, type Str256 } from "../lib/types.ts";
import {
    createAnalysis,
    createOutputDir,
    deleteAnalysis,
    fetchAnalyses,
    fetchAnalysis,
    fetchInputs,
    removeInputs,
    replaceInputs,
    resolveAnalysisContext,
    toAnalysis,
    updateAnalysis,
    workingDirOf,
} from "../client/analyses.ts";
import { createProject, deleteProject, fetchProjects } from "../client/projects.ts";
import { describeBusyReason, type AnalysisSummary, type DeleteAnalysisResponse, type InputView, type WorkspaceDisposalMode } from "../api/analyses.ts";
import { DEFAULT_PER_PAGE, MAX_PER_PAGE } from "../api/common.ts";
import type { PurgedThread, ReportPageFate, ThreadList, ThreadSummary } from "../api/conversation.ts";
import { deleteThread, fetchThread, fetchThreads, purgeThread, restoreThread, updateThread } from "../client/conversation.ts";
import type { ProjectSummary } from "../api/projects.ts";
import { openExternal } from "../lib/open_external.ts";
import type { AgentEffort, AgentName, AgentSelection, ListedModelView as ListedModel, MeView, ModelList } from "../api/machine.ts";
import { fetchAgents, fetchMe, fetchModels, fetchSettings, updateAgent } from "../client/machine.ts";
import { createTransfer } from "../client/store.ts";
import { contractHome } from "../lib/paths.ts";
import { writeClipboard } from "../lib/clipboard.ts";
import { useDialogBindings } from "./components/dialog/dialog_host.tsx";
import { formatTokenFigure } from "../lib/usage_format.ts";
import type { Analysis } from "../types/analysis.ts";

// The command registry: the SINGLE source of truth for the palette. Adding a command is one
// entry in `commands`. Each command's `run` acts only through the `Workspace` (the context store
// built in `App`), never stdout — the alt-screen owns the terminal. Command-specific dialogs are
// co-located here as single-caller helpers; the reusable dialog shells live in `components/`.

/** The categories a command groups under in the palette. A domain type, never a raw string. */
export type CommandCategory = "Analysis" | "Session" | "Project" | "View" | "Provider" | "Sandbox" | "App";

/** A stable, dotted command id (e.g. `analysis.new`), decoupled from the display `title`. */
export type CommandId = string;

/** A palette command: metadata plus an action that runs inside the live TUI. */
export type Command = {
    /** Stable id; dispatch keys off this, not the title. */
    id: CommandId;
    /** Label shown in the palette. */
    title: string;
    /** One-line help shown for the highlighted row. */
    description?: string;
    /** Grouping header in the palette. */
    category: CommandCategory;
    /** Display-only shortcut hint (not a binding — v1 has no keybind engine). */
    keybind?: string;
    /** Contextual availability; a command whose predicate returns false is hidden. */
    enabled?: (ws: Workspace) => boolean;
    /** The action, run with the in-app capability surface. */
    run: (ws: Workspace) => void | Promise<void>;
};

/** One line for a person: the message of a server error body, else the description of the client error. */
function clientErrorText(e: ClientError): string {
    return e.type === "http" ? e.body.message : describeClientError(e);
}

/**
 * The working folder of an analysis for an in-place open: `GET {A}`, which takes the instance lock of the
 * analysis on the server and reconciles its anchor folder. `null` after a notice when the open must not
 * happen: a different process holds the lock, or the server does not answer.
 */
async function workingDirFor(a: Analysis): Promise<string | null> {
    return (await fetchAnalysis(a.id, { cwd: process.cwd() })).match(
        (detail) => workingDirOf(detail),
        (e) => {
            notify({ kind: "warn", text: clientErrorText(e) });
            return null;
        },
    );
}

/**
 * Why the workspace folder of the analysis must not move or be retired now, phrased to finish "Cannot X
 * while …", from `GET {A}`. `null` when it may. It runs before a dialog opens, thus the user does not spend
 * a confirmation on a refusal. The server checks again at the change itself (409 `busy`), because nothing
 * is modal across clients.
 */
async function workspaceBusyReason(analysisId: string): Promise<string | null> {
    return (await fetchAnalysis(analysisId, { cwd: process.cwd() })).match(
        (detail) => (detail.busy[0] === undefined ? null : describeBusyReason(detail.busy[0])),
        (e) => `the analysis cannot be read (${clientErrorText(e)})`,
    );
}

/**
 * How the restore picker walks the widened thread listing. The size is the thread store's own
 * per-request ceiling, so it is the fewest round trips the store will serve; the page cap bounds the
 * walk against a store that never stops reporting more, at a reach far past any real analysis.
 */
const ARCHIVED_PAGE_SIZE = 200;
const ARCHIVED_PAGE_LIMIT = 25;

/**
 * How the session flows (switch / rename / delete) and the in-place analysis open reach the server and
 * the screen. Tests replace each one, so each flow runs offline — no server, no toast overlay.
 * Production callers omit the argument.
 */
export type SessionOpts = {
    /** True when the server runtime is ready to read the threads. Real: the boot phase is `ready`. */
    readonly ready: () => boolean;
    /**
     * An analysis's live conversations, most-recently-active first. The listing narrows on the
     * `conversation` type, thus a report child stays out of it. A report is reached from the
     * conversation that spawned it, and never as a session of its own in this list.
     * Real: `GET {A}/threads?type=conversation`, one page of the server default.
     */
    readonly listThreads: (analysisId: string) => ResultAsync<ThreadList, ClientError>;
    /**
     * The report children of ONE conversation, most-recently-active first. The listing narrows on the
     * parent thread and on the `report` type. Thus a report of a different parent, and a child of a
     * different type, both stay out. Real: `GET {A}/threads?type=report&parentThreadId=`.
     *
     * The read gives the LIVE children alone. The store hides a tombstoned row until `includeArchived`
     * widens the listing, and this read never widens it. An archive stamps the whole subtree, thus one
     * archive removes a child from each surface at the same time.
     */
    readonly listReportChildren: (analysisId: string, parentThreadId: string) => ResultAsync<ThreadList, ClientError>;
    /** One thread's row, or `null` when absent/archived. Real: {@link fetchThread}. */
    readonly getThread: (analysisId: string, threadId: string) => ResultAsync<ThreadSummary | null, ClientError>;
    /** Retitle a thread; `null` when the row is gone. Real: `PATCH {T}`. */
    readonly updateTitle: (analysisId: string, threadId: string, title: string) => ResultAsync<ThreadSummary | null, ClientError>;
    /**
     * One page of an analysis's CONVERSATIONS widened to include the archived ones — the store widens
     * the set rather than switching to an archived-only one, so a caller wanting the tombstoned rows
     * alone narrows on `archivedAt` itself. Real: `GET {A}/threads?type=conversation&includeArchived=true`.
     *
     * The type narrow keeps a report session out of the restore picker. An archive stamps the whole
     * subtree, thus archiving one conversation tombstones each report session under it. The restore
     * lifts ONE row, thus a report session restored on its own would sit live under a parent that is
     * still hidden, and no live listing reaches such a row. A row that leads nowhere does not belong in
     * a picker.
     *
     * The page index is a parameter because the caller must be able to walk the whole set: the widened
     * listing orders by activity, and archiving leaves `updated_at` where the last turn put it, so the
     * tombstoned rows sort BEHIND every live one and a single page can hold none of them.
     */
    readonly listThreadsWithArchived: (analysisId: string, page: number) => ResultAsync<ThreadList, ClientError>;
    /**
     * Archive a thread: stamp its tombstone so it stops listing, keeping the row and every message. A
     * thread that is already gone archives nothing and succeeds. Real: `DELETE {T}`.
     */
    readonly archiveThread: (analysisId: string, threadId: string) => ResultAsync<void, ClientError>;
    /** Lift a thread's tombstone so it lists again. A thread that is gone restores nothing and succeeds. Real: `POST {T}/restore`. */
    readonly unarchiveThread: (analysisId: string, threadId: string) => ResultAsync<void, ClientError>;
    /**
     * Erase a thread: its metadata row AND every one of its messages, with nothing left to restore,
     * then keep or remove the report page folder of each erased thread. The one thread verb the archive
     * cannot undo. Real: `POST {T}/purge`.
     *
     * The server erases first and names the folders after, because the purge gives the id of each
     * thread that it took, and the folder of a report session takes the name of its thread id. Thus the
     * flow asks the user about the files before the erase.
     */
    readonly purgeThread: (analysisId: string, threadId: string, files: "keep" | "remove") => ResultAsync<PurgedThread, ClientError>;
    /**
     * Whether a chat turn is streaming into the open conversation right now. The harness's thread store
     * cannot observe a host's in-flight turns, so refusing an unrecoverable thread write while one is
     * running is the client's obligation. Real: `chatStatus() === "busy"`.
     */
    readonly chatBusy: () => boolean;
    /** Pick the thread to open for an analysis — most recent, else a fresh mint. Real: {@link resolveThreadId}. */
    readonly resolveThreadId: (analysisId: string) => Promise<string | null>;
    /**
     * An analysis's live working directory, or `null` after a notice when the open must not happen (the
     * instance lock of a different process). Real: {@link workingDirFor}, which reads `GET {A}`.
     */
    readonly workingDirFor: (a: Analysis) => string | null | Promise<string | null>;
    /** Re-read the open thread's row into the sidebar snapshot. Real: {@link refreshOpenThread}. */
    readonly refreshThread: (analysisId: string, threadId: string) => void;
    /** Raise a transient toast. Real: {@link notify}. Injected so refusals and degrades are observable. */
    readonly notify: (notice: Notice) => void;
};

/**
 * The value of a write on a thread, with an absent thread (404) read as `absent`. The thread store
 * treats a write on a missing row as a no-op, and the flows keep that reading.
 */
function absentOn404<T>(result: ResultAsync<T, ClientError>, absent: T): ResultAsync<T, ClientError> {
    return result.orElse((e) => (e.type === "http" && e.status === 404 ? okAsync(absent) : errAsync(e)));
}

/**
 * The production {@link SessionOpts}.
 *
 * Exported so a test can observe the narrowing, which lives HERE and nowhere else: `listThreads` and
 * `listReportChildren` differ only by the filters they send, and a replacement shows what the FAKE was
 * told rather than what the real one asks the server for.
 */
export const DEFAULT_SESSION_OPTS: SessionOpts = {
    ready: () => bootState().phase === "ready",
    listThreads: (analysisId) => fetchThreads(analysisId, { type: "conversation" }, { page: 0, perPage: DEFAULT_PER_PAGE }),
    listReportChildren: (analysisId, parentThreadId) => fetchThreads(analysisId, { type: "report", parentThreadId }, { page: 0, perPage: DEFAULT_PER_PAGE }),
    getThread: (analysisId, threadId) => fetchThread(analysisId, threadId),
    updateTitle: (analysisId, threadId, title) =>
        absentOn404(
            updateThread(analysisId, threadId, { title }).map((thread): ThreadSummary | null => thread),
            null,
        ),
    listThreadsWithArchived: (analysisId, page) =>
        fetchThreads(analysisId, { type: "conversation", includeArchived: true }, { page, perPage: ARCHIVED_PAGE_SIZE }),
    archiveThread: (analysisId, threadId) =>
        absentOn404(
            deleteThread(analysisId, threadId).map(() => undefined),
            undefined,
        ),
    unarchiveThread: (analysisId, threadId) =>
        absentOn404(
            restoreThread(analysisId, threadId).map(() => undefined),
            undefined,
        ),
    purgeThread: (analysisId, threadId, files) =>
        absentOn404(purgeThread(analysisId, threadId, { files }), { purged: [], pages: files === "keep" ? { kind: "kept" } : { kind: "removed" } }),
    chatBusy: () => chatStatus() === "busy",
    resolveThreadId,
    workingDirFor,
    refreshThread: (analysisId, threadId) => void refreshOpenThread(analysisId, threadId),
    notify,
};

// Monotonic token ordering the scope write below. Two rapid switches (palette, sidebar, a delete's
// landing) interleave their thread listings and the OLDER can resolve last, dropping the user back on
// the analysis they just moved off. Re-checking the token after the await makes the open STARTED last
// the one that lands. Mirrors `metadataGeneration` in `hooks/thread.ts`.
let openGeneration = 0;

/**
 * Open an analysis's chat in place: bind its most-recently-active thread (else a freshly minted id
 * whose row the first turn creates) and swap the scope. Pre-`ready` the resolver hands back `null` —
 * Postgres is the thread store's only source — and the scope is left unbound, which the boot-edge
 * resolver (`hooks/thread.ts`) then fills in; binding a mint here instead would hide the analysis's
 * real threads behind an empty chat for the rest of the session.
 *
 * Exported for tests; the palette commands and the delete landings are the production callers.
 */
export async function openAnalysis(ws: Workspace, a: Analysis, opts: SessionOpts = DEFAULT_SESSION_OPTS): Promise<void> {
    const mine = ++openGeneration;
    // `GET {A}` first: it takes the instance lock, thus a refused open swaps nothing.
    const workingDir = await opts.workingDirFor(a);
    if (workingDir === null || mine !== openGeneration) return;
    const threadId = await opts.resolveThreadId(a.id);
    if (mine !== openGeneration) return;
    ws.openSession(threadId, workingDir, a);
}

/** Map a {@link VerifyResult} status to the appropriate notice severity. */
function noticeKindFor(result: VerifyResult): "info" | "warn" | "error" {
    switch (result.status) {
        case "valid":
        case "unsigned":
        case "empty":
            return "info";
        case "no-key":
            return "warn";
        case "tampered":
        case "invalid-attestation":
        case "invalid-key":
        case "verify-error":
            return "error";
    }
}

/**
 * The theme picker, previewing live: the highlighted theme is applied to the running render root as
 * the cursor moves, and only a selection persists it. Exported for its render test, which drives the
 * preview/revert/persist contract through the real dialog host.
 */
export function ThemePicker(): JSX.Element {
    const ws = useWorkspace();
    const current = readConfig().theme;
    const items = themeIds.map((id) => ({ value: id, title: themes[id].name, hint: id === current ? "current" : undefined }));
    return (
        <SelectDialog
            title="Change theme"
            placeholder={`Search themes${GLYPHS.ellipsis}`}
            items={items}
            emptyText="No themes"
            // Open ON the persisted theme. At row 0 the mount-time cursor callback would fire with the
            // first listed theme instead, so merely opening the picker would flash anyone on another
            // theme over to that one.
            initialValue={current}
            // Live preview: apply, never persist. The mount-time fire is a deliberate no-op — it
            // re-applies the theme that is already active. `undefined` means the filter matched nothing,
            // so enter would pick nothing; the preview means "what enter would apply now", so it reverts
            // to the persisted theme rather than freezing the last previewed one.
            onCursorChange={(id) => setTheme(id ?? current)}
            // The ONE revert site: the dialog host funnels every non-commit dismissal (esc,
            // click-outside, ctrl+c) into the cancel callback, so undoing the preview here covers all of
            // them. A selection closes with a commit reason, which fires no cancel.
            onCancel={() => {
                setTheme(current);
                ws.closeDialog();
            }}
            onSelect={(id: ThemeId) => {
                setTheme(id); // live recolor of the running render root
                writeConfig({ ...readConfig(), theme: id }).match(
                    () => notify({ kind: "info", text: `Theme: ${themes[id].name}` }),
                    (e) => notify({ kind: "error", text: `Failed to save theme: ${e.type}` }),
                );
                ws.closeDialog();
            }}
        />
    );
}

/** Display label for an agent in notices and picker titles. */
function agentLabel(agent: AgentName): string {
    if (agent === "conversation") return "Chat";
    if (agent === "sandbox") return "Sandbox";
    return "Utility";
}

/**
 * Save an agent's pick through `PUT /api/v1/agents/:role`. The server validates the model against the
 * account, writes the model and the effort in one config write, and applies the pick now or behind the agent
 * work in flight. Gives the inline error of a refused model, or `null` when the pick is saved. A save that
 * failed for a different reason raises a notice and gives `null`, thus the picker closes on it.
 */
async function saveAgentSelection(agent: AgentName, selection: AgentSelection): Promise<string | null> {
    const label = `${selection.model} ${GLYPHS.middot} ${selection.effort}`;
    return (await updateAgent(agent, selection)).match(
        (response) => {
            notify(
                response.status === "applied"
                    ? { kind: "info", text: `${agentLabel(agent)} model: ${label}` }
                    : { kind: "info", text: `${agentLabel(agent)} model set to ${label} — applies when agent work settles` },
            );
            void refreshAgentModels();
            return null;
        },
        (e) => {
            if (e.type === "http" && e.body.error === "validation_error") return e.body.message;
            notify({ kind: "error", text: `Failed to save model: ${describeClientError(e)}` });
            return null;
        },
    );
}

/**
 * Orchestrate one commit attempt: save the pick, then either close or surface the inline error that the
 * server gave. Extracted from {@link ModelPickerDialog} so the save→decide flow is testable headlessly with
 * injected effects; the dialog supplies only the effects and owns the busy/error rendering around this call.
 */
export async function runModelCommit(
    selection: AgentSelection,
    effects: { save: (selection: AgentSelection) => Promise<string | null>; onSaved: () => void; reportError: (message: string) => void },
): Promise<void> {
    const refusal = await effects.save(selection);
    if (refusal === null) effects.onSaved();
    else effects.reportError(refusal);
}

/** The manual-entry row's sentinel value — a non-id token so it can never collide with a real model id. */
const MANUAL_MODEL_SENTINEL = "__manual__";

/**
 * The picker's rows: the connection's models in listing order with the agent's current one marked, then the
 * manual-entry escape hatch. Built as a pure function so the row set — which row carries the sentinel, which
 * is marked `current`, and that the escape hatch is `pinned` — is assertable without a rendered dialog.
 *
 * The manual row is `pinned` because the filter query here is a MODEL ID: the moment the user types the very
 * id they opened this row to enter, fuzzy ranking would drop the row (its label shares no subsequence with
 * `grok-4`) and leave an empty list — hiding the escape hatch at precisely the keystroke that asks for it.
 *
 * NO row here carries a `description`, and the manual row least of all. The detail line renders for the CURSOR
 * row only, so in a list where just one row is described, landing on that row grows the dialog's fixed height
 * budget and shrinks the scroll viewport — after the scroll that brought the row into view has already run
 * against the taller layout. The row the cursor just reached is pushed back out of sight, leaving its own
 * description on screen describing a row nobody can see. Wrapping across a `list-primitives` capability is the
 * only thing that could make a described row safe here; until then the explanation lives on the prompt this
 * row opens, which has room for it and no cursor to lose.
 */
export function modelPickerItems(
    models: readonly ListedModel[],
    current: string,
    effortHint: (model: ListedModel) => string | undefined = () => undefined,
): SelectItem<string>[] {
    return [
        ...models.map((m) => ({
            value: m.id,
            title: m.id,
            // A getter, not a value: the list keeps the item reference and reads `hint` inside its render,
            // thus the effort a left or right key selects repaints the row with no new item array.
            get hint(): string | undefined {
                const parts = [m.id === current ? "current" : undefined, effortHint(m)].filter((p) => p !== undefined);
                return parts.length === 0 ? undefined : parts.join(` ${GLYPHS.middot} `);
            },
        })),
        { value: MANUAL_MODEL_SENTINEL, title: `Enter a model id manually${GLYPHS.ellipsis}`, pinned: true },
    ];
}

/**
 * The effort a model runs at when the picker holds `wanted`: `wanted` itself when the model lists it, else
 * the deepest listed rung below it, else the shallowest listed rung. `null` when the model lists none. Thus
 * a cursor move to a model with a shorter ladder never shows an effort that the model cannot take, and the
 * held effort comes back on a model that has it.
 */
export function effortFor(model: ListedModel, wanted: AgentEffort): AgentEffort | null {
    if (model.efforts.length === 0) return null;
    if (model.efforts.includes(wanted)) return wanted;
    const rank = AGENT_EFFORTS.indexOf(wanted);
    const below = model.efforts.filter((e) => AGENT_EFFORTS.indexOf(e) < rank);
    return below.at(-1) ?? model.efforts[0] ?? null;
}

/**
 * The agent-parameterized model picker: a {@link SelectDialog} over the connection's live models with the
 * agent's CURRENT model marked, degrading to a {@link PromptDialog} free-text entry when listing failed
 * (`models === null`). A pinned manual-entry row ({@link modelPickerItems}) opens that same free-text field
 * even when a listing IS present — so an id the connection does not enumerate stays reachable, mirroring
 * direct-setup, which always prompts free text — and esc there returns to the list rather than closing the
 * picker, since the row was reached FROM it. A committed pick (listed OR free-text) goes to `save`, and the
 * server validates its accessibility (design D6) before it persists — while it saves, the picker shows a busy
 * {@link PromptDialog}; a refused model keeps it open with the inline error of the server; a saved pick closes.
 *
 * The busy and inline-error affordances are PromptDialog's ONLY — {@link SelectDialog} has neither — so
 * the save phase renders as a PromptDialog regardless of which surface the pick came from. A listed
 * pick therefore CONVERGES onto that same prompt (id pre-filled) rather than growing a bespoke list busy/
 * error state, which the design-gallery rule forbids inventing. The picking-phase surfaces are unchanged,
 * so the inert design-gallery/test exhibits render exactly as before (`save` is never reached at rest).
 *
 * Left and right step the effort of the cursor row through the efforts that its model lists, and the row
 * hint shows the result. A commit carries that effort. A model with no efforts, and a free-text id, keep
 * the current effort of the agent.
 */
export function ModelPickerDialog(props: {
    agent: AgentName;
    /** The connection's models with their efforts, or `null` when listing failed (degrade to free-text entry). */
    models: readonly ListedModel[] | null;
    /** Why the listing failed, as the server says it, shown under the free-text field. */
    listingFailure?: string;
    /** The agent's currently-running model, marked `current` in the list and pre-filled in the listing-failure free-text field. */
    current: string;
    /** The agent's currently-running effort: the seed of the left and right keys, and the effort of a model that lists none. */
    currentEffort: AgentEffort;
    /**
     * Save a committed model and effort; the picker renders the busy/error phases around it. Gives the inline
     * error of a refused model, or `null` when the pick is done.
     */
    save: (selection: AgentSelection) => Promise<string | null>;
    /** Close after a saved pick. */
    onSaved: () => void;
    /** Close without changing anything (esc, click-outside, ctrl+c). */
    onCancel: () => void;
}): JSX.Element {
    // A thunk so the fixed-per-mount `props.agent` read lands inside JSX (a tracked scope), satisfying
    // solid/reactivity without destructuring or a disable.
    const title = (): string =>
        props.agent === "conversation" ? "Switch chat model" : props.agent === "sandbox" ? "Switch sandbox model" : "Switch utility model";

    // The picker's own sub-phase. `picking` shows the list/free-text surface; a commit moves it to
    // `checking` (busy prompt) and then either persists+closes or lands on `error` (stays open, names the
    // model). `pending`/`errorText` seed EMPTY (not from props) — they are only ever READ in the
    // checking/error PromptDialog, which renders only after `commit()` has set them, so no props leak in.
    const [phase, setPhase] = createSignal<"picking" | "checking" | "error">("picking");
    const [pending, setPending] = createSignal("");
    const [errorText, setErrorText] = createSignal("");

    // The list surface offers a manual-entry row so an id the connection does not enumerate can still be
    // chosen — the same affordance direct-setup gives by always prompting free text. Selecting it flips this
    // on, routing the render to the free-text PromptDialog below (with the list present, so it is NOT the
    // "listing failed" branch).
    const [manual, setManual] = createSignal(false);

    // The effort the left and right keys hold across cursor moves. Each row shows it through `effortFor`,
    // thus it stays one value while the rows have different ladders.
    // eslint-disable-next-line solid/reactivity -- seed-once: the picker mounts once for each open with a fixed current effort, and the keys own the value after that
    const [effort, setEffort] = createSignal<AgentEffort>(props.currentEffort);
    const [cursorId, setCursorId] = createSignal<string | undefined>(undefined);
    const listed = (id: string | undefined): ListedModel | undefined => (id === undefined ? undefined : props.models?.find((m) => m.id === id));

    function stepEffort(delta: -1 | 1): void {
        const model = listed(cursorId());
        if (!model) return;
        const shown = effortFor(model, effort());
        if (shown === null) return;
        const next = model.efforts[model.efforts.indexOf(shown) + delta];
        if (next !== undefined) setEffort(next);
    }

    // Left and right take the keys from the filter input while the list shows, thus the caret of the
    // filter does not move. A model id filter is short, and the keys are worth more on the effort.
    useDialogBindings(() => ({
        enabled: phase() === "picking" && !manual() && props.models !== null,
        bindings: [
            { chord: KEYS.left, run: () => stepEffort(-1), desc: "Lower effort", group: "Model" },
            { chord: KEYS.right, run: () => stepEffort(1), desc: "Raise effort", group: "Model" },
        ],
    }));

    function commit(raw: string): void {
        const id = raw.trim();
        if (!id) {
            notify({ kind: "warn", text: "A model id is required." });
            return;
        }
        const model = listed(id);
        const chosen = (model ? effortFor(model, effort()) : null) ?? props.currentEffort;
        setPending(id);
        setErrorText("");
        setPhase("checking");
        void runModelCommit(
            { model: id, effort: chosen },
            {
                save: props.save,
                onSaved: () => {
                    // Drop out of `checking` BEFORE onSaved closes: the busy close-guard vetoes even a
                    // programmatic commit close (dialog_host `dialogClose`), and PromptDialog's guard reads
                    // `busy` (= phase === "checking") LIVE — so clearing the phase first lets the close through.
                    setPhase("picking");
                    props.onSaved();
                },
                reportError: (message) => {
                    setErrorText(message);
                    setPhase("error");
                },
            },
        );
    }

    return (
        <Show
            when={phase() === "picking"}
            fallback={
                <PromptDialog
                    title={title()}
                    value={pending()}
                    placeholder="Enter a model id"
                    busy={phase() === "checking"}
                    busyText={`Checking ${pending()}${GLYPHS.ellipsis}`}
                    description={phase() === "error" ? () => <text fg={theme().error}>{errorText()}</text> : undefined}
                    onCancel={props.onCancel}
                    onSubmit={commit}
                />
            }
        >
            <Show
                // `!manual()` FIRST so `&&` yields the models array (not a bare boolean) when both hold —
                // the `keyed` child renders that array, so the truthy branch must resolve to it, not to `true`.
                when={!manual() && props.models}
                keyed
                fallback={
                    <PromptDialog
                        title={title()}
                        // Pre-fill ONLY when the listing failed: there the current id is invisible otherwise, so
                        // offering it to edit saves retyping. Reached from a present list it is already on screen
                        // (marked `current`) and the user chose manual entry precisely to name a DIFFERENT id — a
                        // pre-fill there is text to clear, not a head start.
                        value={props.models ? "" : props.current}
                        placeholder="Enter a model id"
                        description={() => (
                            <box>
                                <text fg={theme().fgMuted}>
                                    {props.models
                                        ? "Enter an id this connection does not list — it is checked against your account before it applies."
                                        : "Could not list the connection's models — enter a model id manually."}
                                </text>
                                <Show when={props.models === null ? props.listingFailure : undefined} keyed>
                                    {(reason: string) => <text fg={theme().fgMuted}>{`Cause: ${reason}.`}</text>}
                                </Show>
                            </box>
                        )}
                        // Back to the list, not out of the picker: this prompt was reached FROM the list, so esc
                        // means "I didn't want manual entry after all". With no list there is nowhere to go back to.
                        onBack={props.models ? () => setManual(false) : undefined}
                        onCancel={props.onCancel}
                        onSubmit={commit}
                    />
                }
            >
                {(models: readonly ListedModel[]) => (
                    <SelectDialog
                        title={title()}
                        placeholder={`Search models${GLYPHS.ellipsis}`}
                        items={modelPickerItems(models, props.current, (m) => {
                            if (m.id !== cursorId()) return undefined;
                            const shown = effortFor(m, effort());
                            return shown === null ? undefined : `${GLYPHS.arrowLeft} ${shown} ${GLYPHS.arrowRight}`;
                        })}
                        onCursorChange={setCursorId}
                        footerHint={`${chordLabel(KEYS.left)}${chordLabel(KEYS.right)} effort`}
                        // Unreachable while the manual row is pinned (it always survives the filter), but the
                        // list primitive owns that guarantee, not this caller — so the text still has to be right.
                        emptyText="No models match"
                        onCancel={props.onCancel}
                        onSelect={(value) => (value === MANUAL_MODEL_SENTINEL ? setManual(true) : commit(value))}
                    />
                )}
            </Show>
        </Show>
    );
}

/**
 * Open the model picker for `agent`. Boot-gated like `analysis.reprofile` (the picker shows the selection that
 * the live runtime runs): refuse with a notice while booting rather than a silent no-op. Reads the agents
 * (`GET /api/v1/agents`) and the connection's models UNCACHED (`GET /api/v1/models`, `null` with the reason on
 * failure → free-text mode) before opening, then hands the picker the current model to mark.
 */
async function openModelPicker(ctx: Workspace, agent: AgentName): Promise<void> {
    if (bootState().phase !== "ready") {
        notify({ kind: "info", text: `Harness is still booting${GLYPHS.ellipsis}` });
        return;
    }
    const agents = await fetchAgents();
    if (agents.isErr()) {
        notify({ kind: "error", text: describeClientError(agents.error) });
        return;
    }
    const view = agents.value.agents.find((entry) => entry.role === agent);
    if (view?.current === null || view === undefined) {
        notify({ kind: "info", text: `Harness is still booting${GLYPHS.ellipsis}` });
        return;
    }
    const current = view.current;
    const listing = (await fetchModels()).match(
        (list): ModelList => list,
        (e): ModelList => ({ models: null, reason: describeClientError(e) }),
    );
    ctx.openDialog(() => (
        <ModelPickerDialog
            agent={agent}
            models={listing.models}
            listingFailure={listing.models === null ? listing.reason : undefined}
            current={current.model}
            currentEffort={current.effort}
            save={(selection) => saveAgentSelection(agent, selection)}
            onSaved={() => ctx.closeDialog()}
            onCancel={() => ctx.closeDialog()}
        />
    ));
}

function NewProjectDialog(): JSX.Element {
    const ws = useWorkspace();
    return (
        <PromptDialog
            title="New project"
            placeholder="Project name"
            onCancel={() => ws.closeDialog()}
            onSubmit={(raw) => {
                ws.closeDialog();
                str256(raw).match(
                    (name) =>
                        void createProject({ name }).match(
                            (p) => notify({ kind: "info", text: `Created project "${p.name}"` }),
                            (e) => notify({ kind: "error", text: clientErrorText(e) }),
                        ),
                    (err) => notify({ kind: "warn", text: err === "empty" ? "A name is required." : "Keep the name to 256 characters or fewer." }),
                );
            }}
        />
    );
}

function NewAnalysisDialog(): JSX.Element {
    const ws = useWorkspace();
    return (
        <PromptDialog
            title="New analysis"
            placeholder="Analysis name"
            onCancel={() => ws.closeDialog()}
            onSubmit={(raw) => {
                ws.closeDialog();
                str256(raw).match(
                    // Inputs are user-driven, so this flow gathers them explicitly: creation waits
                    // for the file picker chained after the name prompt rather than enrolling anything
                    // by default.
                    (name) => ws.openDialog(() => <NewAnalysisInputsDialog name={name} />),
                    (err) => notify({ kind: "warn", text: err === "empty" ? "A name is required." : "Keep the name to 256 characters or fewer." }),
                );
            }}
        />
    );
}

function NewAnalysisInputsDialog(props: { name: Str256 }): JSX.Element {
    const ws = useWorkspace();
    return (
        <FilePicker
            rootPath={ws.workingDir}
            selectedPaths={new Set<string>()}
            confirmLabel="Create"
            requireSelection
            onConfirm={(paths) => {
                ws.closeDialog();
                // A deliberate action, so minting the anchor marker here is allowed (no-litter policy).
                // The picker's selection rides in as `inputs` so the new analysis is seeded with
                // exactly the files the user chose — the server enrolls nothing on its own.
                // Awaited off the handler: the creation makes the farm, and a farm
                // failure surfaces its own message here.
                void createAnalysis({ name: props.name, folder: ws.workingDir, inputs: paths }).match(
                    (a) => {
                        void openAnalysis(ws, toAnalysis(a));
                        notify({ kind: "info", text: `Created analysis "${a.name}"` });
                    },
                    (e) => notify({ kind: "error", text: clientErrorText(e) }),
                );
            }}
            onCancel={() => ws.closeDialog()}
        />
    );
}

/**
 * Copy the cursor row's analysis id. Ctrl-modified, NOT a bare `y`: the switcher is a single-mode
 * picker whose filter input holds focus for the whole life of the dialog, so a bare printable would be
 * swallowed as typed text. Ctrl and never Alt — terminals deliver Alt/Option unreliably, and macOS
 * composes Option into a character. One constant so the binding and its footer label cannot drift.
 */
const COPY_ANALYSIS_ID: Chord = { key: "y", ctrl: true };

/** What the analysis pickers of the palette read and drive. Tests replace each one. */
export type AnalysisDialogOpts = {
    /** The client of the local server. */
    readonly client: ClientOpts;
    /** Open an analysis in place. Real: {@link openAnalysis}. */
    readonly openAnalysis: (ws: Workspace, a: Analysis) => Promise<void>;
};

/** The production {@link AnalysisDialogOpts}. */
export const DEFAULT_ANALYSIS_DIALOG_OPTS: AnalysisDialogOpts = {
    client: DEFAULT_CLIENT_OPTS,
    openAnalysis: (ws, a) => openAnalysis(ws, a),
};

/**
 * Each analysis, newest first, one bounded page for each request. `null` after an error notice: a picker
 * over a part of the list would hide analyses without a word.
 */
async function fetchAllAnalyses(client: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<AnalysisSummary[] | null> {
    const all: AnalysisSummary[] = [];
    for (let page = 0; ; page++) {
        const list = await fetchAnalyses({ page, perPage: MAX_PER_PAGE }, client);
        if (list.isErr()) {
            notify({ kind: "error", text: `Could not list the analyses: ${clientErrorText(list.error)}` });
            return null;
        }
        all.push(...list.value.analyses);
        if (!list.value.hasMore) return all;
    }
}

/**
 * The analysis switcher — and the ONE place the interface reports a whole-analysis total.
 *
 * Every other surface reports the entity it names or the open working context; this is where analyses
 * are compared, which is the only question an analysis-wide total answers. Its figures come with the
 * analysis list of the server, which reads the ledger once for each page (never a query per drawn row)
 * and needs no booted runtime.
 *
 * A failed usage read leaves the figures absent: a picker that cannot switch analyses because a
 * bookkeeping read failed is a far worse outcome than a picker with no figures.
 */
/** The `analysis.switch` command: read the analyses, then open the picker over them. Exported for tests. */
export async function openSwitchAnalysis(ctx: Workspace, opts: AnalysisDialogOpts = DEFAULT_ANALYSIS_DIALOG_OPTS): Promise<void> {
    const analyses = await fetchAllAnalyses(opts.client);
    if (analyses !== null) ctx.openDialog(() => <SwitchAnalysisDialog analyses={analyses} opts={opts} />);
}

function SwitchAnalysisDialog(props: { analyses: AnalysisSummary[]; opts: AnalysisDialogOpts }): JSX.Element {
    const ws = useWorkspace();
    // eslint-disable-next-line solid/reactivity -- seed-once: the dialog mounts one time with the list that its opener read, and a new read opens a new dialog
    const items = props.analyses.map((a) => {
        const totals = a.usage;
        // The CACHED anchor path, as the list gives it: a read-only display must not trigger the
        // reconciliation (and its `lastSeen` write) that a resolve by id performs.
        const folder = a.anchorPath;
        return {
            value: a,
            title: a.name,
            // Grouped by anchor ID, headed by its folder. Keying on the path instead would MERGE two
            // live anchors that share a stale cachedPath (delete `.inflexa/id`, re-init in place, and
            // the old row keeps that path) — mixing a dead anchor's analyses in with the current ones,
            // which is the exact ambiguity this grouping exists to remove.
            category: a.anchorId,
            categoryLabel: folder === null ? "(folder unknown)" : contractHome(folder),
            // An analysis with nothing recorded carries NO figure rather than a zeroed one: absent means
            // not-reported everywhere the ledger is read, and `formatTokenFigure` returns the empty
            // string for exactly that state.
            hint: [absTimeShort(a.createdAt), totals ? formatTokenFigure(totals) || undefined : undefined].filter(Boolean).join(` ${GLYPHS.middot} `),
            // The one place a row's unambiguous handle lives: the name repeats across anchors and the
            // slug repeats within them, so neither identifies a row on its own.
            description: `${a.id} ${GLYPHS.middot} ${a.slug} ${GLYPHS.middot} created ${absTime(a.createdAt)}`,
        };
    });
    // Mirrored from the list so the copy binding below can act on the highlighted row: the list owns
    // the cursor, and `onCursorChange` is the sanctioned way for a host to read it.
    const [cursor, setCursor] = createSignal<AnalysisSummary | undefined>(items[0]?.value);
    useDialogBindings(() => ({
        bindings: [
            {
                chord: COPY_ANALYSIS_ID,
                run: () => {
                    const a = cursor();
                    if (!a) return;
                    void writeClipboard(a.id); // best-effort, never rejects → notify optimistically
                    notify({ kind: "info", text: `Copied analysis id ${a.id}` });
                },
                desc: "Copy analysis id",
                group: "Analysis",
            },
        ],
    }));
    return (
        <SelectDialog
            title="Switch analysis"
            placeholder={`Search analyses${GLYPHS.ellipsis}`}
            items={items}
            emptyText="No analyses yet — use ctrl+k → New analysis to create one"
            // Derived from the chord itself, so the footer can never advertise a key the binding lost.
            footerHint={`${chordLabel(COPY_ANALYSIS_ID)} copy id`}
            onCursorChange={setCursor}
            onCancel={() => ws.closeDialog()}
            onSelect={(a: AnalysisSummary) => {
                ws.closeDialog();
                void props.opts.openAnalysis(ws, toAnalysis(a));
            }}
        />
    );
}

/**
 * A thread's picker label — its pg-owned title, which is seeded from the first user message and so is
 * absent on a row that predates one. Shared by the picker and the delete confirmation so both name the
 * same conversation the same way.
 */
function threadLabel(thread: ThreadSummary): string {
    return thread.title ?? "Untitled conversation";
}

/**
 * The open thread's row as a THREE-way outcome — the row, no row, or the read itself failing.
 *
 * The third case is why this exists. "No row yet" is a normal state (the first turn creates it) and
 * the flows below refuse it with advice — send a message first, there is nothing to remove. Folding a
 * `DbError` into that same branch would hand a user whose Postgres blinked a claim about their data
 * that is false, and a remedy that cannot work. Absence and unreadability are different facts, so the
 * caller gets to say different things about them.
 */
type ThreadRead = { kind: "row"; thread: ThreadSummary } | { kind: "none" } | { kind: "unreadable" };

async function readOpenThread(analysisId: string, threadId: string, opts: SessionOpts): Promise<ThreadRead> {
    return (await opts.getThread(analysisId, threadId)).match(
        (t): ThreadRead => (t === null ? { kind: "none" } : { kind: "row", thread: t }),
        (): ThreadRead => ({ kind: "unreadable" }),
    );
}

/**
 * Start a fresh conversation in the open analysis: mint a thread id and swap the chat onto it in place.
 * The row that id names is not written until the first turn creates it (typed `conversation` by the
 * harness default, its title seeded from the message), so nothing is persisted here — which is why
 * re-running from an already-empty chat is a harmless no-op needing no guard, and why rapid repeats that
 * mint several identities cost nothing.
 *
 * Synchronous by construction. Unlike {@link openSwitchSession} there is no Postgres round trip before
 * the swap, so the open scope cannot change mid-body and the stale-analysis re-check that guards the
 * picker's async gap has nothing to guard here.
 *
 * The pre-`ready` refusal speaks rather than no-ops, exactly as {@link openSwitchSession}'s does: the
 * palette hides this command until `ready`, but a dispatch by id skips that predicate, so this path is
 * reachable while the runtime is still booting. Binding a mint pre-`ready` would also suppress the
 * ready-edge resolution that opens the most-recent thread — a surprising loss for a command dispatched
 * early by accident — so it refuses instead.
 */
export function newSessionFlow(ctx: Workspace, opts: SessionOpts = DEFAULT_SESSION_OPTS): void {
    const analysis = ctx.analysis;
    if (!analysis) return;
    const phase = bootState().phase;
    if (phase !== "ready") {
        // `failed` is terminal, so "still booting" would promise a wait that never ends and contradict
        // the status bar the user is looking at. Every other non-ready phase IS a wait.
        opts.notify(
            phase === "failed"
                ? { kind: "warn", text: "The harness did not start — conversations are unavailable." }
                : { kind: "info", text: `Harness is still booting${GLYPHS.ellipsis}` },
        );
        return;
    }
    ctx.openSession(randomUUIDv7(), ctx.workingDir, analysis);
}

/**
 * The Switch-session picker's creation row carries this sentinel as its `value`, distinct by identity
 * from every {@link ThreadSummary} the server returns, so the select handler branches "start fresh" from "reopen
 * this thread" without a marker field on either.
 */
const NEW_SESSION = Symbol("new-session");

/** A Switch-session pick: an existing thread to reopen, or the pinned creation row. */
type SwitchSessionChoice = ThreadSummary | typeof NEW_SESSION;

/**
 * The Switch-session picker's rows: the analysis's live conversations (most-recently-active first), followed
 * by a pinned "Start a new session" row. The creation row comes LAST so the default selection stays the
 * most-recent thread — this picker is for switching, and the create action is the escape hatch out of
 * the list, not its headline. Being pinned, the row survives any filter query and an empty thread set,
 * so the picker is never empty and the create action is always one keystroke away; last-placement also
 * keeps it put, since a query matching no conversation re-appends dropped pinned rows at the end.
 */
export function switchSessionItems(threads: ThreadSummary[]): SelectItem<SwitchSessionChoice>[] {
    return [
        // Durable-record rule: a listed conversation is a referenced record, so its last-activity stamp
        // is an absolute local time rather than a compact age.
        ...threads.map((t) => ({ value: t, title: threadLabel(t), description: new Date(t.updatedAt).toLocaleString() })),
        { value: NEW_SESSION, title: "Start a new session", pinned: true },
    ];
}

/**
 * Dispatch a Switch-session pick. The pinned sentinel runs the shared new-session mint-and-swap — the
 * one {@link newSessionFlow} the palette command also runs, never a second copy of the mint — while any
 * other row reopens that thread under the analysis captured when the picker opened. The dialog closes
 * first either way.
 */
export function selectSwitchSession(ctx: Workspace, choice: SwitchSessionChoice, analysis: Analysis, opts: SessionOpts): void {
    ctx.closeDialog();
    if (choice === NEW_SESSION) {
        newSessionFlow(ctx, opts);
        return;
    }
    ctx.openSession(choice.id, ctx.workingDir, analysis);
}

/**
 * Open the session picker over the analysis's live conversations (most-recently-active first). Fetched
 * BEFORE the dialog opens — the thread store is an async server read, so the dialog cannot pull it
 * from its own body — mirroring `openRunsPicker`. A read failure degrades to an empty picker rather
 * than a crash.
 *
 * The pre-ready refusal speaks rather than no-ops: the palette hides this command until `ready`, but
 * its leader chord dispatches by id and bypasses that predicate, so this path IS reachable while the
 * runtime is still booting (the same shape as `analysis.reprofile`).
 */
export async function openSwitchSession(ctx: Workspace, opts: SessionOpts = DEFAULT_SESSION_OPTS): Promise<void> {
    const analysis = ctx.analysis;
    if (!analysis) return;
    const phase = bootState().phase;
    if (phase !== "ready" || !opts.ready()) {
        // `failed` is terminal, so "still booting" would promise a wait that never ends and contradict
        // the status bar the user is looking at. Every other non-ready phase IS a wait.
        opts.notify(
            phase === "failed"
                ? { kind: "warn", text: "The harness did not start — conversations are unavailable." }
                : { kind: "info", text: `Harness is still booting${GLYPHS.ellipsis}` },
        );
        return;
    }
    const threads = (await opts.listThreads(analysis.id)).match(
        (page) => page.threads,
        (): ThreadSummary[] => {
            opts.notify({ kind: "warn", text: "Could not list this analysis's conversations." });
            return [];
        },
    );
    // The listing is a server round trip and NOTHING is modal across it — the picker has not opened
    // yet, so the analysis-switch keys are still live. Opening the picker anyway would list the
    // previous analysis's conversations, and selecting one would bind that thread beside the working
    // directory of the analysis now open: a scope naming two different analyses at once. Once the
    // picker IS open it holds the modal mode, which is what freezes the scope for as long as it lives.
    if (ctx.analysis?.id !== analysis.id) {
        opts.notify({ kind: "info", text: "Analysis changed — reopen the session picker for this one." });
        return;
    }
    ctx.openDialog(() => (
        <SelectDialog
            title="Switch session"
            placeholder={`Search sessions${GLYPHS.ellipsis}`}
            items={switchSessionItems(threads)}
            // The pinned "Start a new session" row keeps this list non-empty in every real case, so this
            // text is the contract for an items-empty render rather than a line a user reaches: a fresh
            // chat with no other conversation still sees that row, not this.
            emptyText="No other conversations — send a message to start one, or switch analysis first"
            onCancel={() => ctx.closeDialog()}
            onSelect={(choice: SwitchSessionChoice) => selectSwitchSession(ctx, choice, analysis, opts)}
        />
    ));
}

const REPORT_LIST_FAILED = "Could not list the report sessions of this conversation.";
const OPEN_SESSION_UNREADABLE = "Could not read this session — nothing was opened.";
const NO_REPORT_CHILD = "No report session in this conversation — ask the agent to start one.";

/**
 * The refusal a report-session flow raises before the boot reaches `ready`.
 *
 * `failed` is terminal, thus "still booting" would promise a wait that never ends and contradict the
 * status bar the user reads. Every other non-ready phase IS a wait. The three report flows take their
 * words from here, because one boot state must not reach the user as three different facts.
 */
function reportBootNotice(phase: BootState["phase"]): Notice {
    return phase === "failed"
        ? { kind: "warn", text: "The harness did not start — report sessions are unavailable." }
        : { kind: "info", text: `Harness is still booting${GLYPHS.ellipsis}` };
}

/**
 * What one read of a conversation's report children found — the rows, or the read itself failing.
 *
 * The split is the one {@link ThreadRead} makes, for the same reason. An empty set is a normal state the
 * flows answer with "there is none", and a `DbError` folded into that arm would tell a user whose
 * Postgres blinked a fact about their data that is not true.
 */
type ReportChildren = { readonly kind: "read"; readonly threads: ThreadSummary[] } | { readonly kind: "unreadable" };

/**
 * The report children of ONE conversation, most-recently-active first. The single read behind both
 * surfaces that offer them — the forward chord and the palette command — thus the two can never answer
 * one question with two different sets.
 *
 * One page of the store default, exactly as the switch picker reads one. A conversation past that count
 * loses the tail with no mark on the list. The one-version policy of a report session keeps the count
 * far below it. The rows also sort by the last activity, thus the page holds the children a user
 * reaches for.
 */
async function readReportChildren(analysisId: string, parentThreadId: string, opts: SessionOpts): Promise<ReportChildren> {
    return (await opts.listReportChildren(analysisId, parentThreadId)).match(
        (page): ReportChildren => ({ kind: "read", threads: page.threads }),
        (): ReportChildren => ({ kind: "unreadable" }),
    );
}

/**
 * Whether the scope captured before an await is still the open one. It raises the refusal itself when
 * it is not, thus a caller reads one branch and never repeats the words.
 *
 * A thread read is a server round trip and NOTHING is modal across it, thus the analysis-switch AND
 * the session-switch keys stay live. Each report flow crosses that window, and a swap that lands anyway
 * acts on the conversation the user just left. The two facts break differently:
 *
 * - A changed analysis binds a thread of the previous analysis beside the working directory of the
 *   analysis open now, which is one scope naming two analyses.
 * - A changed session opens the parent of a conversation the user moved off, or a report child that
 *   hangs off it. Both rows are real, thus nothing downstream refuses them.
 *
 * The sibling session flows of this file split the two the same way, for the same reason.
 */
function scopeStillOpen(ctx: Workspace, analysis: Analysis, threadId: string | null, opts: SessionOpts): boolean {
    if (ctx.analysis?.id !== analysis.id) {
        opts.notify({ kind: "info", text: "Analysis changed — nothing was opened." });
        return false;
    }
    if (ctx.sessionId !== threadId) {
        opts.notify({ kind: "info", text: "Session changed — nothing was opened." });
        return false;
    }
    return true;
}

/**
 * The report picker's rows. A report child IS a session, thus a row carries what a row of
 * {@link switchSessionItems} carries: the thread's title, and its last-activity stamp as an absolute
 * local time (the durable-record rule — a listed conversation is a referenced record).
 *
 * Each row also carries its session id, in the two forms that answer two different questions. The
 * short handle joins the TITLE, which is what the SESSION rail chip prints, thus a reader matches a row
 * against the rail without reading anything else. It is also the one part of a row that ranks, thus a
 * user who has the handle can type it. The FULL id joins the detail line, which renders for the cursor
 * row alone: it is what tells two rows of one title apart, and what a user pastes elsewhere, while 36
 * characters on every row would crowd the titles they sit beside.
 *
 * `openThreadId` names the row the chat already has open, so a picker opened from inside a report
 * session says which of the siblings the reader is looking at. `hint` and not the title, because it is
 * a fact about the app rather than about the session — the same field, and the same word tier, that
 * the theme and model pickers mark their current row with.
 *
 * There is no pinned creation row, and that difference from the switch picker is deliberate: the agent
 * spawns a report session, thus this picker has no create action it could honestly offer.
 */
export function reportSessionItems(threads: ThreadSummary[], openThreadId: string | null = null): SelectItem<ThreadSummary>[] {
    return threads.map((t) => ({
        value: t,
        title: `${threadLabel(t)} ${GLYPHS.middot} ${shortSessionId(t.id)}`,
        hint: t.id === openThreadId ? "open" : undefined,
        description: `${t.id} ${GLYPHS.middot} ${new Date(t.updatedAt).toLocaleString()}`,
    }));
}

/**
 * Open the picker over one conversation's report children. The single picker behind both surfaces, thus
 * the forward chord and the palette command render one component over one population.
 *
 * The pick swaps the chat in place under the analysis captured before the read. A report child belongs to
 * the conversation that spawned it, and that conversation belongs to this analysis, thus the swap moves
 * the thread alone.
 *
 * `openThreadId` is the thread bound when the listing was read, which the rows mark as open. It is that
 * snapshot and not a live read, thus the picker names the session its own population was built for.
 */
function openReportPicker(ctx: Workspace, analysis: Analysis, threads: ThreadSummary[], openThreadId: string | null): void {
    ctx.openDialog(() => (
        <SelectDialog
            title="Switch report session"
            placeholder={`Search report sessions${GLYPHS.ellipsis}`}
            items={reportSessionItems(threads, openThreadId)}
            // The forward chord opens this picker only above one child, thus the palette command is the
            // one surface that reaches an empty set. The text names what puts a row here.
            emptyText="No report session in this conversation — ask the agent to start one"
            onCancel={() => ctx.closeDialog()}
            onSelect={(thread: ThreadSummary) => selectReportSession(ctx, thread, analysis)}
        />
    ));
}

/**
 * Dispatch a report-session pick: close the dialog, then swap the chat onto that thread under the
 * analysis captured when the picker opened. The swap moves the thread alone, because a report child
 * belongs to the conversation that spawned it and that conversation belongs to this analysis.
 *
 * The row of the OPEN session is a landmark and not a destination: a picker listing the siblings of a
 * report child holds the open one among them, thus its pick closes the dialog and stops there. The
 * swap is what a re-open would cost — it resets the chat's hot state and reloads the transcript the
 * user is already reading, for a session they never left.
 *
 * The comparison reads the LIVE scope rather than the id the picker opened over, thus a session that
 * changed while the dialog stood open is compared against what is bound now.
 *
 * Exported for the reason {@link selectSwitchSession} is: the handler carries the whole behavior of a
 * pick, and nothing can reach it through a mounted dialog.
 */
export function selectReportSession(ctx: Workspace, thread: ThreadSummary, analysis: Analysis): void {
    ctx.closeDialog();
    if (ctx.sessionId === thread.id) return;
    ctx.openSession(thread.id, ctx.workingDir, analysis);
}

/**
 * Open the parent conversation of the open report child, in place.
 *
 * The parent belongs to the same analysis as its child — the thread store refuses a create that says
 * otherwise — thus the swap moves the thread and never the analysis.
 *
 * The pre-`ready` refusal speaks rather than no-ops, as {@link openSwitchSession}'s does. This flow has
 * no palette command whose `enabled` could hide it, and its leader chord dispatches by id, thus it is
 * reachable while the runtime still boots.
 */
export async function openParentSession(ctx: Workspace, opts: SessionOpts = DEFAULT_SESSION_OPTS): Promise<void> {
    const analysis = ctx.analysis;
    const threadId = ctx.sessionId;
    // An absent analysis or an unbound thread names no session the user could have meant, thus the
    // narrowing is silent.
    if (!analysis || threadId === null) return;
    const phase = bootState().phase;
    if (phase !== "ready" || !opts.ready()) {
        opts.notify(reportBootNotice(phase));
        return;
    }
    const read = await readOpenThread(analysis.id, threadId, opts);
    if (read.kind === "unreadable") {
        opts.notify({ kind: "error", text: OPEN_SESSION_UNREADABLE });
        return;
    }
    // A thread with no row is a conversation whose first turn has not landed, because the spawn writes a
    // report child's row before that child exists anywhere. Thus absence and a conversation row are one
    // answer here, and a report row carrying no parent link is that same answer again.
    const parentId = read.kind === "row" && read.thread.threadType === "report" ? (read.thread.parentThreadId ?? null) : null;
    if (parentId === null) {
        opts.notify({ kind: "info", text: "This session has no parent — a report session opens the conversation that spawned it." });
        return;
    }
    await opts.getThread(analysis.id, parentId).match(
        (parent) => {
            // A parent that resolves to no row is a NORMAL state, never a fault: the read hides an
            // archived row, and the chat scope can name a thread another client has moved since. To
            // name the absence and leave the user where they are is the whole remedy.
            if (parent === null) {
                opts.notify({ kind: "warn", text: "The parent conversation is no longer listed — nothing was opened." });
                return;
            }
            if (!scopeStillOpen(ctx, analysis, threadId, opts)) return;
            ctx.openSession(parent.id, ctx.workingDir, analysis);
        },
        () => opts.notify({ kind: "error", text: "Could not read the parent conversation — nothing was opened." }),
    );
}

/**
 * Open a report child of the open conversation, in place.
 *
 * One child opens with no picker, because a picker over one row asks the user to confirm what the
 * keystroke already said. Above one child the shared picker opens. The count comes from the one read,
 * thus no second query decides which of the two shapes the user gets.
 *
 * Each dead direction speaks. A silent key reads as a broken key, and the two reasons a user meets here —
 * an open report session, and a conversation with no child — are different facts about their data.
 */
export async function openReportSession(ctx: Workspace, opts: SessionOpts = DEFAULT_SESSION_OPTS): Promise<void> {
    const analysis = ctx.analysis;
    const threadId = ctx.sessionId;
    if (!analysis || threadId === null) return;
    const phase = bootState().phase;
    if (phase !== "ready" || !opts.ready()) {
        opts.notify(reportBootNotice(phase));
        return;
    }
    const read = await readOpenThread(analysis.id, threadId, opts);
    if (read.kind === "unreadable") {
        opts.notify({ kind: "error", text: OPEN_SESSION_UNREADABLE });
        return;
    }
    if (read.kind === "row" && read.thread.threadType === "report") {
        opts.notify({ kind: "info", text: "This is a report session — the thread tree stays flat, thus a report session spawns none of its own." });
        return;
    }
    // A thread with no row has no child either. Thus the flow skips the second read, and it answers
    // exactly as an empty set answers.
    if (read.kind === "none") {
        opts.notify({ kind: "info", text: NO_REPORT_CHILD });
        return;
    }
    const children = await readReportChildren(analysis.id, threadId, opts);
    if (children.kind === "unreadable") {
        opts.notify({ kind: "warn", text: REPORT_LIST_FAILED });
        return;
    }
    if (!scopeStillOpen(ctx, analysis, threadId, opts)) return;
    // Destructured rather than indexed: this hands the one-child arm its row and the count in one step,
    // where an index read is typed `ThreadSummary | undefined` and wants a guard at each site.
    const [first, ...rest] = children.threads;
    if (!first) {
        opts.notify({ kind: "info", text: NO_REPORT_CHILD });
        return;
    }
    if (rest.length === 0) {
        ctx.openSession(first.id, ctx.workingDir, analysis);
        return;
    }
    // The open thread is the conversation these rows hang off, thus no row can name it and the marker
    // never appears on this path. It is passed all the same, because the picker takes the open session
    // of the flow that built it rather than deciding for itself which flow it serves.
    openReportPicker(ctx, analysis, children.threads, threadId);
}

/**
 * Open the report picker over the report sessions of the open family, from the palette.
 *
 * It ALWAYS opens the picker, and {@link openReportSession} does not. The chord is a movement, thus one
 * child is the answer it acts on. This command is a browse, thus the list IS the answer — at one row, and
 * at none, where the picker's own empty state names what puts a row there.
 *
 * WHICH family it lists comes from the open row. A conversation lists its own children. A report child
 * lists the children of its parent, which is that child and its siblings, thus the picker inside a
 * report session is never empty and the family reads the same from either side. The tree is flat, so
 * one hop up reaches the whole of it.
 *
 * The open row is read first, and an unreadable one refuses rather than falling back to the children of
 * the bound thread: a report child has no children of its own, thus that fallback would open an empty
 * picker stating there is no report session — inside one.
 *
 * The reads run before the dialog opens, as {@link openSwitchSession}'s do: the thread store is an async
 * server read that a dialog body cannot pull from itself. A failed listing degrades to a notice.
 */
export async function openSwitchReportSession(ctx: Workspace, opts: SessionOpts = DEFAULT_SESSION_OPTS): Promise<void> {
    const analysis = ctx.analysis;
    const threadId = ctx.sessionId;
    if (!analysis) return;
    const phase = bootState().phase;
    if (phase !== "ready" || !opts.ready()) {
        opts.notify(reportBootNotice(phase));
        return;
    }
    // The command is offered on an open analysis and a ready boot, and neither of those binds a thread. A
    // report child hangs off the conversation that spawned it, thus an unbound scope names no population
    // to list.
    if (threadId === null) {
        opts.notify({ kind: "info", text: "No conversation is open — a report session belongs to one." });
        return;
    }
    const read = await readOpenThread(analysis.id, threadId, opts);
    if (read.kind === "unreadable") {
        opts.notify({ kind: "error", text: OPEN_SESSION_UNREADABLE });
        return;
    }
    // A thread with no row yet is a conversation whose first turn has not landed, and a report row whose
    // parent link is gone names no family above it. Both list under the open thread, which is what a
    // conversation does — the second then lists nothing, and the picker's empty state says so.
    const parentId = read.kind === "row" && read.thread.threadType === "report" ? read.thread.parentThreadId : undefined;
    const children = await readReportChildren(analysis.id, parentId ?? threadId, opts);
    if (children.kind === "unreadable") {
        opts.notify({ kind: "warn", text: REPORT_LIST_FAILED });
        return;
    }
    if (!scopeStillOpen(ctx, analysis, threadId, opts)) return;
    openReportPicker(ctx, analysis, children.threads, threadId);
}

function AnalysesListDialog(props: { analyses: AnalysisSummary[] }): JSX.Element {
    const ws = useWorkspace();
    // eslint-disable-next-line solid/reactivity -- seed-once: the dialog mounts one time with the list that its opener read, and a new read opens a new dialog
    const lines = props.analyses.map((a) => `${a.name}  —  ${a.slug}`);
    return <ResultsDialog title="Analyses" lines={lines} emptyText="No analyses yet" onClose={() => ws.closeDialog()} />;
}

/**
 * Reach-back picker over the session's openable artifacts (charts, figures, files),
 * newest-first. Each row shows the entry name + its resolved path; selecting one opens it externally
 * through the shared opener. Complements the `o` binding (which opens the single most-recent card).
 * The command resolves each path before the dialog opens, because the list reads its items once.
 */
function BrowseArtifactsDialog(props: { items: SelectItem<SessionOpenable>[] }): JSX.Element {
    const ws = useWorkspace();
    return (
        <SelectDialog
            title="Browse artifacts"
            placeholder={`Search artifacts${GLYPHS.ellipsis}`}
            items={props.items}
            emptyText="No artifacts shown in this session yet"
            onCancel={() => ws.closeDialog()}
            onSelect={(openable: SessionOpenable) => {
                ws.closeDialog();
                openArtifact(openable.analysisId, openable.entry);
            }}
        />
    );
}

/**
 * The Status dialog's model block: the shared connection spelled out — provider, mode, and what the
 * mode means — plus each agent's live model and any scheduled switch. This is the home of the
 * connection detail the sidebar's fixed-width rail deliberately drops (the rail shows only the
 * provider slug), so the mode glosses stay in the user's vocabulary, not config slugs alone. A failed
 * boot surfaces its actionable message here; before ready the block mirrors the rail's
 * "runtime not ready". Exported for tests only — the dialog is the sole production caller.
 */
export function modelStatusLines(): string[] {
    const boot = bootState();
    if (boot.phase === "failed") return [`models: boot failed ${GLYPHS.emDash} ${boot.message}`];
    if (boot.phase !== "ready") return ["models: runtime not ready"];
    const gloss = boot.connection.mode === "cliproxy" ? "managed local proxy" : "user-configured endpoint";
    const models = agentModels();
    const agentLine = (label: string, agent: AgentName): string => {
        // Em dash until the runtime installs the live switch — the same placeholder the sidebar renders.
        const effort = models.efforts?.[agent];
        const current = (models.current[agent] || GLYPHS.emDash) + (effort ? ` ${GLYPHS.middot} ${effort}` : "");
        const pending = models.pending.get(agent);
        return pending ? `${label}: ${current} ${GLYPHS.arrowRight} ${pending.model} ${GLYPHS.middot} ${pending.effort} (pending)` : `${label}: ${current}`;
    };
    return [
        `connection: ${boot.connection.provider} ${GLYPHS.middot} ${boot.connection.mode} (${gloss})`,
        agentLine("chat model", "conversation"),
        agentLine("sandbox model", "sandbox"),
        agentLine("utility model", "utility"),
    ];
}

function StatusDialog(props: { contextLine: string }): JSX.Element {
    const ws = useWorkspace();
    return <ResultsDialog title="Status" lines={[props.contextLine, "", ...modelStatusLines()]} emptyText="No context" onClose={() => ws.closeDialog()} />;
}

/** Read the server settings, then open the settings screen over them. A failed read raises a notice and opens nothing. */
async function openSettings(ctx: Workspace): Promise<void> {
    (await fetchSettings()).match(
        (settings) => ctx.openDialog(() => <ConfigApp settings={settings} onClose={() => ctx.closeDialog()} />),
        (e) => notify({ kind: "error", text: describeClientError(e) }),
    );
}

/**
 * Confirm-to-destroy: type the entity name to proceed. Prevents accidental destructive actions.
 *
 * `verb` exists because this ritual — danger chrome plus typing the name back — is the app's
 * strongest "this cannot be undone" signal, and it must not be spent on an action that keeps the
 * data. A caller whose removal is recoverable says so in the verb (and spells out what survives in
 * `description`), so the words the user reads match what the store actually does.
 */
function ConfirmDeleteDialog(props: {
    entityLabel: string;
    entityName: string;
    /** The action as the user should understand it. Defaults to `Delete` — the irreversible one. */
    verb?: string;
    /** Optional line between the title and the field, for stating what a removal does and does not reclaim. */
    description?: () => JSX.Element;
    onConfirm: () => void;
}): JSX.Element {
    const ws = useWorkspace();
    return (
        <PromptDialog
            title={`${props.verb ?? "Delete"} ${props.entityLabel}?`}
            tone="danger"
            description={props.description}
            placeholder={`Type "${props.entityName}" to confirm`}
            onCancel={() => ws.closeDialog()}
            onSubmit={(raw) => {
                if (raw.trim() !== props.entityName) {
                    // Names the mismatch, not the action: the title above already said which action
                    // was being confirmed, and this dialog now serves both deletes and removals.
                    notify({ kind: "warn", text: "Name does not match — cancelled." });
                    ws.closeDialog();
                    return;
                }
                ws.closeDialog();
                props.onConfirm();
            }}
        />
    );
}

/**
 * Second step of deleting an analysis: what happens to the bytes. Deleting the row is not enough
 * on its own — the slug keys the workspace directory and is handed straight to the next analysis
 * of the same name, so the tree must leave `analyses/` either way. Keeping is the default: a run's
 * artifacts are the user's work, and an archive is recoverable where an `rm -rf` is not.
 *
 * Both descriptions name what the choice does NOT cover. The mode governs the workspace tree alone:
 * the conversations, the run history, and the analysis's own provenance chain are reclaimed on
 * either branch, so copy that spoke only of what the archive preserves would read as a promise to
 * keep the whole analysis — and the user would discover otherwise only after the irreversible step.
 */
function DeleteAnalysisFilesDialog(props: { analysis: Analysis; onDecided: (disposal: "archive" | "delete") => void }): JSX.Element {
    const ws = useWorkspace();
    return (
        <SelectDialog
            title={`Delete "${props.analysis.name}" — keep its files?`}
            items={[
                {
                    value: "archive" as const,
                    title: "Keep the files",
                    description: `Move the workspace to .inflexa/analyses_archived/${props.analysis.slug}/, keeping its inputs, run artifacts, reports, and a signed provenance export — the conversations and run history are removed either way`,
                },
                {
                    value: "delete" as const,
                    title: "Delete the files permanently",
                    description: "Remove the workspace directory and everything in it, along with the conversations and run history. This cannot be undone",
                },
            ]}
            emptyText="No options"
            onCancel={() => ws.closeDialog()}
            onSelect={(disposal) => {
                ws.closeDialog();
                props.onDecided(disposal);
            }}
        />
    );
}

/**
 * Second step of deleting a session: what happens to its files. A report session writes its page into a
 * directory that takes the name of its thread id. The erase reaches the open thread and each descendant
 * of it, thus after it no surface can name those directories again.
 *
 * The copy names no conversation. The open thread can be a report session itself, and that delete takes
 * one thread and one page.
 *
 * The question comes on each delete, and it tests no directory first. The erase gives back the threads
 * that it took, and it gives them only after it runs. Thus a question that spoke of the directories
 * that are really there would have to come after the point of no return.
 *
 * Keeping is the default, as it is for an analysis. A page is the work of the user, and a removal of it
 * cannot be undone.
 */
function DeleteSessionFilesDialog(props: { sessionName: string; onDecided: (files: "keep" | "remove") => void }): JSX.Element {
    const ws = useWorkspace();
    return (
        <SelectDialog
            title={`Delete "${props.sessionName}" — keep its report files?`}
            items={[
                {
                    value: "keep" as const,
                    title: "Keep the files",
                    description: "Leave the page of each report that this delete erases on disk — the messages are erased either way",
                },
                {
                    value: "remove" as const,
                    title: "Delete the files permanently",
                    description: "Remove the page directory of each report that this delete erases, with each staged asset in it. This cannot be undone",
                },
            ]}
            emptyText="No options"
            onCancel={() => ws.closeDialog()}
            onSelect={(files) => {
                ws.closeDialog();
                props.onDecided(files);
            }}
        />
    );
}

/**
 * Why deletion is refused without a booted harness, raised both at the palette gate (before the user
 * spends a confirmation on it) and again inside the ladder, which cannot obtain a pool either way.
 * One string so the two refusals can never drift into telling the user different things.
 */
const DELETE_NEEDS_HARNESS =
    "Cannot delete while the harness is not running — deleting also reclaims this analysis's conversations and run history, which live in the harness's database.";

/**
 * Why the thread verbs cannot run without a booted harness: thread metadata lives only in Postgres,
 * so before `ready` there is nothing to remove, restore, or erase. One string so the flows that raise
 * it cannot drift into describing the same unavailability two ways.
 */
const SESSION_NEEDS_HARNESS = "The harness is not running — this analysis's conversations are unavailable until it starts.";

/** What the delete of an analysis drives in the client. Tests replace each one, thus the flow runs offline. */
export type AnalysisDeleteOpts = {
    /** `DELETE {A}`: the server runs the ordered delete. A kept folder gets a signed PROV-JSON export first. */
    readonly deleteAnalysis: (analysisId: string, workspace: WorkspaceDisposalMode) => ResultAsync<DeleteAnalysisResponse, ClientError>;
    /** The newest analysis that is left, to land on, or `null` when none is left or the read fails. */
    readonly nextAnalysis: () => Promise<Analysis | null>;
    /** Land the chat on a surviving analysis. Real: {@link openAnalysis}. */
    readonly openAnalysis: (ws: Workspace, a: Analysis) => Promise<void>;
    /** Raise a transient toast. Real: {@link notify}. Injected so every outcome is observable. */
    readonly notify: (notice: Notice) => void;
};

/** The production {@link AnalysisDeleteOpts}. */
export const DEFAULT_ANALYSIS_DELETE_OPTS: AnalysisDeleteOpts = {
    deleteAnalysis: (analysisId, workspace) => deleteAnalysis(analysisId, { workspace, export: workspace === "keep" ? "prov-json" : "none" }),
    nextAnalysis: async () =>
        (await fetchAnalyses({ page: 0, perPage: 1 })).match(
            (list) => (list.analyses[0] === undefined ? null : toAnalysis(list.analyses[0])),
            () => null,
        ),
    openAnalysis: (ws, a) => openAnalysis(ws, a),
    notify,
};

/**
 * Delete an analysis through the server, then land the chat on the newest analysis that is left, or quit
 * when none is. The server runs the ordered delete (`DELETE {A}`): the provenance export into a kept
 * folder, the disposal of the folder, the purge of the stored conversations and run history, and only
 * then the row. A failed disposal or purge leaves the analysis in place, and its message says so.
 *
 * A failed export does not stop the delete: the user asked to delete the analysis, not to export
 * provenance. The fact rides the outcome notice of the delete, because the toast channel replaces what is
 * showing with the next arrival.
 */
export async function deleteAnalysisWith(
    ctx: Workspace,
    a: Analysis,
    disposal: "archive" | "delete",
    opts: AnalysisDeleteOpts = DEFAULT_ANALYSIS_DELETE_OPTS,
): Promise<void> {
    const deleted = await opts.deleteAnalysis(a.id, disposal === "archive" ? "keep" : "delete");
    if (deleted.isErr()) {
        const e = deleted.error;
        const code = e.type === "http" ? e.body.error : null;
        opts.notify({
            kind: code === "busy" || code === "not_found" || code === "unavailable" ? "warn" : "error",
            text: code === "unavailable" ? DELETE_NEEDS_HARNESS : clientErrorText(e),
        });
        return;
    }
    const { workspace, export: exported } = deleted.value;
    const fate = workspace.kind === "archived" ? `files kept at ${workspace.path}` : workspace.kind === "deleted" ? "files deleted" : "it had no files on disk";
    const provenanceNote =
        exported === "failed"
            ? ", but its provenance could not be exported"
            : exported === "written_unflushed"
              ? ", though its provenance export may be missing this session's last activity"
              : "";
    opts.notify({ kind: provenanceNote ? "warn" : "info", text: `Deleted analysis "${a.name}" — ${fate}${provenanceNote}` });
    const next = await opts.nextAnalysis();
    if (next !== null) void opts.openAnalysis(ctx, next);
    else void ctx.quit();
}

/** The lines of the Identity dialog for the account of `GET /api/v1/me`. */
function identityLines(me: MeView): string[] {
    if (!me.signedIn) return [me.error];
    const lines: string[] = [];
    if (me.name) lines.push(`Name:    ${me.name}`);
    if (me.email) lines.push(`Email:   ${me.email}`);
    if (me.subject) lines.push(`Subject: ${me.subject}`);
    const expiresAt = new Date(me.expiresAt);
    const status = expiresAt.getTime() > Date.now() ? `active — expires ${expiresAt.toLocaleString()}` : "expired — renews on next use";
    lines.push(`Session: ${status}`);
    return lines;
}

/** Read the account of the server, then open the Identity dialog. A failed read shows its instruction in the dialog. */
async function openIdentity(ctx: Workspace): Promise<void> {
    const lines = (await fetchMe()).match(identityLines, (e) => [describeClientError(e)]);
    ctx.openDialog(() => <ResultsDialog title="Identity" lines={lines} emptyText="Not logged in" onClose={() => ctx.closeDialog()} />);
}

/**
 * Each project, newest first, one bounded page for each request. `null` after an error notice.
 */
async function fetchAllProjects(): Promise<ProjectSummary[] | null> {
    const all: ProjectSummary[] = [];
    for (let page = 0; ; page++) {
        const list = await fetchProjects({ page, perPage: MAX_PER_PAGE });
        if (list.isErr()) {
            notify({ kind: "error", text: `Could not list the projects: ${clientErrorText(list.error)}` });
            return null;
        }
        all.push(...list.value.projects);
        if (!list.value.hasMore) return all;
    }
}

function ProjectListDialog(props: { projects: ProjectSummary[] }): JSX.Element {
    const ws = useWorkspace();
    // eslint-disable-next-line solid/reactivity -- seed-once: the dialog mounts one time with the list that its opener read, and a new read opens a new dialog
    const lines = props.projects.map((p) => {
        const tags = p.tags.length ? ` [${p.tags.join(", ")}]` : "";
        return `${p.name}${tags}  (${p.analysisCount} analyses)`;
    });
    return <ResultsDialog title="Projects" lines={lines} emptyText="No projects yet" onClose={() => ws.closeDialog()} />;
}

function SetProjectDialog(props: { projects: ProjectSummary[] }): JSX.Element {
    const ws = useWorkspace();
    const a = ws.analysis;
    const items = [
        { value: null as string | null, title: "(none)", description: "Clear project grouping" },
        // eslint-disable-next-line solid/reactivity -- seed-once: the dialog mounts one time with the list that its opener read, and a new read opens a new dialog
        ...props.projects.map((p) => ({ value: p.id as string | null, title: p.name, description: p.description ?? undefined })),
    ];
    return (
        <SelectDialog
            title="Set project"
            placeholder={`Search projects${GLYPHS.ellipsis}`}
            items={items}
            emptyText="No projects — create one first"
            onCancel={() => ws.closeDialog()}
            onSelect={(projectId: string | null) => {
                ws.closeDialog();
                if (!a) return;
                void updateAnalysis(a.id, { project: projectId }).match(
                    (detail) => {
                        notify({ kind: "info", text: `Project: ${detail.project?.name ?? "none"}` });
                        // An in-place swap reads the project again, thus the sidebar shows the new one.
                        if (ws.analysis?.id === a.id) ws.openSession(ws.sessionId, ws.workingDir, toAnalysis(detail));
                    },
                    (e) => notify({ kind: "error", text: clientErrorText(e) }),
                );
            }}
        />
    );
}

/**
 * Each input of the analysis, one bounded page for each request. `null` after an error notice: a picker
 * seeded with a part of the set would remove the rest on its apply.
 */
async function fetchAllInputs(analysisId: string, client: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<InputView[] | null> {
    const all: InputView[] = [];
    for (let page = 0; ; page++) {
        const list = await fetchInputs(analysisId, { page, perPage: MAX_PER_PAGE }, client);
        if (list.isErr()) {
            notify({ kind: "error", text: `Could not read the inputs: ${clientErrorText(list.error)}` });
            return null;
        }
        all.push(...list.value.inputs);
        if (!list.value.hasMore) return all;
    }
}

function AddInputDialog(props: { inputs: InputView[] }): JSX.Element {
    const ws = useWorkspace();
    const a = ws.analysis;
    // Existing inputs in the picker's value space (canonical absolute paths). An input whose anchor
    // can't be located has no absolute path and stays OUT of the seed — it can't render as a row, and
    // the server's replacement deliberately never removes what no client could show.
    // eslint-disable-next-line solid/reactivity -- seed-once: the dialog mounts one time with the list that its opener read, and a new read opens a new dialog
    const seed = new Set(props.inputs.flatMap((input) => (input.absolutePath === null ? [] : [input.absolutePath])));
    return (
        <FilePicker
            rootPath={ws.workingDir}
            selectedPaths={seed}
            confirmLabel="Apply"
            onConfirm={(paths) => {
                ws.closeDialog();
                if (!a) return;
                // The picker's final set replaces the inputs: the server adds the paths the user picked and
                // removes the recorded inputs whose rows came back unchecked. Clearing everything is a
                // legitimate outcome here (unlike new-analysis).
                void replaceInputs(a.id, paths).match(
                    (change) => {
                        if (change.added.length === 0 && change.removed.length === 0) notify({ kind: "info", text: "Inputs unchanged" });
                        else notify({ kind: "info", text: `Inputs updated: +${change.added.length} -${change.removed.length}` });
                        ws.refreshScope();
                        // The server re-profiles the new set, and the read arms the poll of the sidebar until the row shows it.
                        void refreshSidebarData(a.id);
                    },
                    (e) => notify({ kind: "error", text: `Input update failed (${clientErrorText(e)})` }),
                );
            }}
            onCancel={() => ws.closeDialog()}
        />
    );
}

/**
 * One input row's muted second line: what kind of thing it is, how big, and when it last changed.
 *
 * A directory contributes no size for the same reason the picker's rows do not — measuring it means
 * walking it. The two degraded phrasings are deliberately different facts: an input whose anchor no
 * longer resolves is one we cannot LOCATE, while a resolved path that fails to stat is one we can
 * locate and cannot FIND. Both stay removable either way, so neither is an error.
 */
function inputMetaLine(input: InputView): string {
    const kind = input.isDir ? "directory" : "file";
    if (input.absolutePath === null) return `${kind} ${GLYPHS.middot} location unknown`;
    return statResult(input.absolutePath, "removeInputs:stat").match(
        (s) =>
            [kind, input.isDir ? undefined : s.size.formatBytes(), absTimeShort(new Date(s.mtimeMs).toISOString())].filter(Boolean).join(` ${GLYPHS.middot} `),
        () => `${kind} ${GLYPHS.middot} not on disk`,
    );
}

/**
 * The flat view of every registered input, with multi-select removal.
 *
 * It stays a SEPARATE surface from "Manage inputs" rather than folding into that picker, because an
 * analysis may span any number of folders (its anchor is a default root, not a fence). The picker
 * seeds a far-away input into its selection but renders no row for it until the user browses to that
 * folder — so this list is the only place the whole input set is visible at once, and the only way
 * to drop an input without navigating to wherever it lives.
 *
 * Rows are titled by ABSOLUTE path, not the stored `path`: the stored form is anchor-relative, which
 * renders two inputs from different anchors as the same string.
 */
/** The `analysis.remove-input` command: read the inputs, then open the flat list over them. Exported for tests. */
export async function openRemoveInputs(ctx: Workspace, client: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const a = ctx.analysis;
    if (!a) return;
    const inputs = await fetchAllInputs(a.id, client);
    if (inputs !== null) ctx.openDialog(() => <RemoveInputsDialog inputs={inputs} client={client} />);
}

function RemoveInputsDialog(props: { inputs: InputView[]; client: ClientOpts }): JSX.Element {
    const ws = useWorkspace();
    const a = ws.analysis;
    // eslint-disable-next-line solid/reactivity -- seed-once: the dialog mounts one time with the list that its opener read, and a new read opens a new dialog
    const items = props.inputs.map((input) => {
        const shown = input.absolutePath ?? input.path;
        return {
            value: input,
            // The trailing separator is the type marker the picker rows already use.
            title: input.isDir ? `${shown}${sep}` : shown,
            meta: inputMetaLine(input),
        };
    });
    return (
        <SelectDialog
            title="Remove inputs"
            placeholder={`Search inputs${GLYPHS.ellipsis}`}
            items={items}
            emptyText="No inputs to remove"
            mode="multi"
            onCancel={() => ws.closeDialog()}
            onConfirm={(chosen: InputView[]) => {
                ws.closeDialog();
                if (!a || chosen.length === 0) return;
                // An input whose folder cannot be located goes by its stored path, which the server
                // matches too, thus it stays removable.
                void removeInputs(
                    a.id,
                    chosen.map((input) => input.absolutePath ?? input.path),
                    props.client,
                ).match(
                    (change) => {
                        const removed = change.removed.length;
                        notify({ kind: "info", text: `Removed ${removed} input${removed === 1 ? "" : "s"}` });
                        ws.refreshScope();
                        void refreshSidebarData(a.id);
                    },
                    (e) => notify({ kind: "error", text: `Input removal failed (${clientErrorText(e)})` }),
                );
            }}
        />
    );
}

function RenameAnalysisDialog(): JSX.Element {
    const ws = useWorkspace();
    return (
        <PromptDialog
            title="Rename analysis"
            placeholder="New name"
            onCancel={() => ws.closeDialog()}
            onSubmit={(raw) => {
                ws.closeDialog();
                const a = ws.analysis;
                if (!a) return;
                str256(raw).match(
                    (name) =>
                        // The slug keys the on-disk workspace, so the server's rename also moves
                        // `.inflexa/analyses/<old>/` → `<new>/` (one deliberate action), or refuses with
                        // 409 `busy` while work holds the folder.
                        void updateAnalysis(a.id, { name }).match(
                            (updated) => {
                                notify({ kind: "info", text: `Renamed to "${updated.name}"` });
                                // The row is authoritative, so the rename stands either way — but a tree
                                // stranded at the old slug is invisible to every later `open`/read, and
                                // the user is the only one who can reconcile it.
                                if (updated.workspaceNotMoved !== undefined) {
                                    notify({
                                        kind: "warn",
                                        text: `Workspace directory could not be moved to the new name — it remains at ${updated.workspaceNotMoved.subdir}/`,
                                    });
                                }
                                // The workspace store (sidebar, status bar) takes the new name.
                                if (ws.analysis?.id === a.id) ws.openSession(ws.sessionId, ws.workingDir, toAnalysis(updated));
                            },
                            (e) => notify({ kind: "error", text: clientErrorText(e) }),
                        ),
                    (err) => notify({ kind: "warn", text: err === "empty" ? "A name is required." : "Keep the name to 256 characters or fewer." }),
                );
            }}
        />
    );
}

/**
 * Open the session rename prompt, pre-filled with the thread's current pg title. The title is
 * pg-owned, so the current value is an async read taken before the dialog opens (as
 * {@link openSwitchSession} does).
 *
 * That read is also the refusal point: the row is created by the FIRST turn, so a conversation that
 * has not had one has nothing to retitle — refusing here costs the user nothing, where opening an
 * empty field and refusing on submit spends their typing on a write that can never land. A read that
 * FAILED refuses too, with no title to pre-fill and no proof the write has a target — but in its own
 * words, per {@link ThreadRead}: a transient fault is not the user's cue to go send a message.
 */
export async function openRenameSession(ctx: Workspace, opts: SessionOpts = DEFAULT_SESSION_OPTS): Promise<void> {
    const analysis = ctx.analysis;
    const threadId = ctx.sessionId;
    // Reachable only through the palette, whose `enabled` already requires both — this restates the
    // gate for the narrowing rather than handling a state the user can actually reach.
    if (!analysis || !opts.ready() || threadId === null) return;
    const read = await readOpenThread(analysis.id, threadId, opts);
    if (read.kind === "unreadable") {
        opts.notify({ kind: "error", text: "Could not read this conversation — its title was not changed." });
        return;
    }
    if (read.kind === "none") {
        opts.notify({ kind: "warn", text: "Send a message first — this conversation has no saved title yet." });
        return;
    }
    // Same window as {@link openSwitchSession}: the row read precedes the prompt, so the session-switch
    // keys are live across it. "Rename session" means the one the user is looking at — opening a prompt
    // pre-filled from the conversation they just left would retitle it under a heading claiming to be
    // about the current one.
    if (ctx.sessionId !== threadId) {
        opts.notify({ kind: "info", text: "Session changed — reopen rename for this one." });
        return;
    }
    // A row can legitimately predate its title (pg seeds it from the first user message), so the
    // field opens empty rather than on a placeholder the user would have to clear.
    const current = read.thread.title ?? "";
    ctx.openDialog(() => (
        <PromptDialog
            title="Rename session"
            placeholder="New title"
            value={current}
            onCancel={() => ctx.closeDialog()}
            onSubmit={(raw) => {
                ctx.closeDialog();
                void commitSessionRename(ctx, analysis.id, threadId, raw, opts);
            }}
        />
    ));
}

/**
 * Write a session's new title and report the outcome. Lives beside the prompt rather than inside its
 * `onSubmit` so the whole decision ladder is testable headlessly (the {@link runModelCommit} shape);
 * the dialog supplies only the raw text and owns its own close.
 *
 * A `null` row here is the concurrent-delete backstop, NOT the "no row yet" case
 * ({@link openRenameSession} already refused that before the prompt opened): the thread was deleted
 * between the prompt opening and this submit, so the write found nothing to land on.
 *
 * Takes the workspace only to re-check what is bound when the write lands — the rename targets a
 * thread id captured when the prompt opened, and the user is free to move off it while the write is
 * in flight.
 */
export async function commitSessionRename(
    ctx: Workspace,
    analysisId: string,
    threadId: string,
    raw: string,
    opts: SessionOpts = DEFAULT_SESSION_OPTS,
): Promise<void> {
    const title = raw.trim();
    if (!title) {
        opts.notify({ kind: "warn", text: "A title is required." });
        return;
    }
    await opts.updateTitle(analysisId, threadId, title).match(
        (thread) => {
            if (thread === null) {
                opts.notify({ kind: "warn", text: "This conversation is no longer saved — its title was not changed." });
                return;
            }
            opts.notify({ kind: "info", text: `Session renamed to "${title}"` });
            // The write changes the row without changing the bound id, so no reactive edge would
            // re-read it — poke the snapshot so the sidebar shows the new title.
            //
            // Only while that id is still the bound one. A session switch during the write (the
            // prompt closes on submit, so the palette is reachable again immediately) leaves this
            // poke aimed at a thread the rail no longer describes, and `refreshOpenThread` would
            // dutifully load it — painting the renamed conversation's title over the open one until
            // some later edge happened to correct it. The rename itself still landed, so the notice
            // above stands either way.
            if (ctx.sessionId === threadId) opts.refreshThread(analysisId, threadId);
        },
        (e) => opts.notify({ kind: "error", text: `Failed: ${describeClientError(e)}` }),
    );
}

/**
 * Remove the open session: confirm by name, tombstone the thread, then land the user on whatever this
 * analysis has left (its next most-recent thread, else a freshly minted empty chat) so the chat is
 * never left bound to a conversation that no longer lists.
 *
 * `DELETE {T}` archives: it sets `deleted_at`, so the row and every message survive and the thread merely
 * stops appearing anywhere — {@link openRestoreSession} is the way back. Every word the user reads
 * therefore says REMOVE, not delete — the confirm ritual (danger chrome, type the name back) is the app's
 * strongest irreversibility signal, and spending it on an action that keeps the transcript, and that
 * the user can undo from the palette, would teach them to distrust it where it is telling the truth.
 */
export async function deleteSessionFlow(ctx: Workspace, opts: SessionOpts = DEFAULT_SESSION_OPTS): Promise<void> {
    const analysis = ctx.analysis;
    const threadId = ctx.sessionId;
    // An absent analysis or an unbound thread names no conversation the user could have meant, so the
    // narrowing is silent; the palette's `enabled` requires both anyway.
    if (!analysis || threadId === null) return;
    // A server that is not ready is the one reachable miss, because the leader chord dispatches by
    // command id and never consults `enabled` — so it speaks rather than swallowing the keystroke,
    // exactly as {@link openRestoreSession} does for the same bypass.
    if (!opts.ready()) {
        opts.notify({ kind: "warn", text: SESSION_NEEDS_HARNESS });
        return;
    }
    // Both refusals below share one cause — no name to confirm against, and asking the user to type a
    // fiction is not a confirmation — but they are not the same fact, so they do not get the same words.
    const read = await readOpenThread(analysis.id, threadId, opts);
    if (read.kind === "unreadable") {
        opts.notify({ kind: "error", text: "Could not read this conversation — nothing was removed." });
        return;
    }
    if (read.kind === "none") {
        opts.notify({ kind: "info", text: "This conversation has nothing saved yet — there is nothing to remove." });
        return;
    }
    // Same window as {@link openSwitchSession}, and the costliest of the three to get wrong: the
    // confirmation would name the conversation the user just left, and confirming it both tombstones
    // that one and re-lands the chat — yanking the user off the session they had switched to, for a
    // removal they did not ask for there.
    if (ctx.sessionId !== threadId) {
        opts.notify({ kind: "info", text: "Session changed — reopen remove for this one." });
        return;
    }
    const name = threadLabel(read.thread);
    ctx.openDialog(() => (
        <ConfirmDeleteDialog
            entityLabel="session"
            entityName={name}
            verb="Remove"
            description={() => <text fg={theme().fgMuted}>It stops appearing in this analysis. The transcript is kept — nothing is erased.</text>}
            onConfirm={() => void confirmSessionDelete(ctx, analysis, threadId, opts)}
        />
    ));
}

/**
 * Archive the confirmed thread, then land the user on whatever the analysis has left. Lives beside
 * the confirmation rather than inside its `onConfirm` so the post-confirm ladder is testable
 * headlessly (the {@link runModelCommit} shape); the dialog owns only the name match and its close.
 *
 * The success notice reports the reach of the write and stops there. Claiming a deletion would be the
 * one statement this flow cannot back up: the transcript is still in Postgres (see {@link deleteSessionFlow}).
 */
export async function confirmSessionDelete(ctx: Workspace, analysis: Analysis, threadId: string, opts: SessionOpts = DEFAULT_SESSION_OPTS): Promise<void> {
    await opts.archiveThread(analysis.id, threadId).match(
        async () => {
            opts.notify({ kind: "info", text: "Session removed — it no longer appears in this analysis." });
            // Unbind BEFORE the landing, which is another server round trip. Across that window the
            // scope would otherwise still name the tombstone, and a turn submitted into it passes every
            // gate: the id is non-null, the thread store's create is a no-op against the existing
            // (soft-deleted) row, and the messages persist onto a thread that lists nowhere — the user's
            // message lands where they can never see it again. `null` routes that same submit through
            // the existing `unbound` refusal instead, which keeps the typed text for the next send.
            //
            // The cost is that the ready-edge watcher sees an unbound scope and starts a resolution of
            // its own beside this one. They converge — both pick the surviving thread, or both mint an
            // identity that nothing has written — so the loser is discarded at no charge but one listing.
            ctx.openSession(null, ctx.workingDir, analysis);
            // Re-enter through the analysis-open path: it performs exactly the landing this
            // needs — bind the surviving most-recent thread, else a fresh mint.
            await openAnalysis(ctx, analysis, opts);
        },
        // The thread is still bound and still lists, so nothing is re-landed — leaving the user
        // exactly where they were is the truthful outcome of a removal that did not happen.
        async (e) => opts.notify({ kind: "error", text: `Failed: ${describeClientError(e)}` }),
    );
}

/**
 * Erase the open session: confirm by name under the danger ritual, hard-delete the thread and every
 * message it holds, then land the user on whatever this analysis has left.
 *
 * Structurally the removal flow above, and deliberately so — the gate, the read, the changed-thread
 * refusal and the unbind-before-landing tail are the same facts about the same scope, and letting the
 * two drift would make one of them wrong. What differs is the confirmation: removal declines the
 * danger ritual because it erases nothing and restore undoes it, while this is the first thread action
 * that cannot be taken back, so it spends the ritual and says outright that the transcript is gone.
 * Reading the two commands side by side in the palette has to be enough to tell them apart, because a
 * user who mistakes this one for the other has no way back.
 */
export async function purgeSessionFlow(ctx: Workspace, opts: SessionOpts = DEFAULT_SESSION_OPTS): Promise<void> {
    const analysis = ctx.analysis;
    const threadId = ctx.sessionId;
    // The same two gates the removal flow raises, in the same order and for the same reasons: silence
    // where no conversation is named, a spoken refusal where the chord bypassed `enabled`.
    if (!analysis || threadId === null) return;
    if (!opts.ready()) {
        opts.notify({ kind: "warn", text: SESSION_NEEDS_HARNESS });
        return;
    }
    // A turn streaming into this very thread is the one state that makes the purge destructive beyond
    // what the user asked for. A turn writes its messages with no foreign key and tolerates a missing
    // thread row, so a turn committing after the purge lands rows under a `thread_id` that resolves to
    // no analysis — reachable by nothing, since the only route from an analysis to its messages is a
    // join through the thread row this deleted. The harness states the precondition and cannot enforce
    // it, because it cannot see a host's in-flight turns, and the server leaves it to the client
    // (draft 2.3); this is where it is met.
    //
    // The narrower check rather than the analysis-wide busy gate: a running data profile or workflow
    // writes nothing into `messages`, so refusing a conversation delete for one would block the user
    // over state that cannot be harmed. `chatStatus` is already thread-scoped here, because this flow
    // only ever purges the OPEN thread. Checked once, before the dialog opens — the modal blocks the
    // composer, so no turn can start between the check and the confirmation.
    //
    // Removal deliberately has no such gate: a turn landing after an archive leaves its messages on a
    // tombstoned row that Restore brings back intact, which is a recoverable outcome, not a loss.
    if (opts.chatBusy()) {
        opts.notify({ kind: "warn", text: "Cannot delete this conversation while a chat turn is running — wait for it to finish, or stop it first." });
        return;
    }
    // Absence and unreadability are different facts about the user's data, so they get different words
    // — the same split the removal flow makes, and for the same reason.
    const read = await readOpenThread(analysis.id, threadId, opts);
    if (read.kind === "unreadable") {
        opts.notify({ kind: "error", text: "Could not read this conversation — nothing was deleted." });
        return;
    }
    if (read.kind === "none") {
        opts.notify({ kind: "info", text: "This conversation has nothing saved yet — there is nothing to delete." });
        return;
    }
    // The costliest window in the app to get wrong: the confirmation would name the conversation the
    // user just left, and typing that name would erase it — irrecoverably, for a conversation they were
    // not even looking at.
    if (ctx.sessionId !== threadId) {
        opts.notify({ kind: "info", text: "Session changed — reopen delete for this one." });
        return;
    }
    const name = threadLabel(read.thread);
    ctx.openDialog(() => (
        <ConfirmDeleteDialog
            entityLabel="session"
            entityName={name}
            // No `verb`: the default IS "Delete", and this is the action that word was reserved for.
            description={() => <text fg={theme().fgMuted}>Every message in it is erased. This cannot be undone — Restore session cannot bring it back.</text>}
            // The files question stacks over the name confirmation, exactly as the analysis delete
            // stacks its own. The two steps ask different things: the first names what goes from the
            // stores, and the second decides what happens to the files that the stores can no longer
            // name.
            onConfirm={() => {
                ctx.openDialog(() => (
                    <DeleteSessionFilesDialog sessionName={name} onDecided={(files) => void confirmSessionPurge(ctx, analysis, threadId, files, opts)} />
                ));
            }}
        />
    ));
}

/**
 * The tail of the delete notice, which gives the fate of the files in the words of {@link ReportPageFate}.
 *
 * Each line states the outcome on disk, and none of them counts a page. A forced removal cannot report
 * whether a directory was there, and the common delete is a conversation that owns no page at all. Thus
 * a line that said "its pages are removed" would name work that never ran.
 *
 * `unlocatable` is the one line that names a cause. The server cannot locate the workspace, and the user
 * can act on that fact alone. An empty `stayed` list is the guard arm: an id that the path helper
 * refused leaves a page with no name to print, and the workspace resolved, thus that line must not
 * blame the workspace.
 */
function describeReportPageFate(fate: ReportPageFate): string {
    switch (fate.kind) {
        case "kept":
            return "no report page was removed";
        case "removed":
            return "no report page remains";
        case "unlocatable":
            return "its report pages stayed, because its workspace did not resolve";
        case "stayed":
            return fate.dirs.length === 0 ? "its report pages stayed, and nothing can name them" : `these report pages stayed: ${fate.dirs.join(", ")}`;
    }
}

/**
 * Hard-delete the confirmed thread with the file choice of the user, then land the user on whatever the
 * analysis has left. Lives beside the confirmation rather than inside its `onConfirm` so the post-confirm
 * ladder is testable headlessly (the {@link confirmSessionDelete} shape); the dialog owns only the name
 * match and its close.
 *
 * The server erases first and handles the files after, because the erase gives the id of each thread
 * that it took and nothing else can. A failed erase leaves each file where it is, because a page whose
 * rows survive is still reachable.
 *
 * The unbind runs before the landing, which is a server round trip. The scope names an erased id across
 * that window, and the composer is open, thus a turn submitted into it would mint the row back.
 */
export async function confirmSessionPurge(
    ctx: Workspace,
    analysis: Analysis,
    threadId: string,
    files: "keep" | "remove",
    opts: SessionOpts = DEFAULT_SESSION_OPTS,
): Promise<void> {
    const purged = await opts.purgeThread(analysis.id, threadId, files);
    if (purged.isErr()) {
        // The thread is still there and still lists, so nothing is re-landed — leaving the user exactly
        // where they were is the truthful outcome of a deletion that did not happen.
        opts.notify({ kind: "error", text: `Failed: ${describeClientError(purged.error)}` });
        return;
    }

    // Unbind BEFORE the landing's round trip. Across that window the scope would otherwise still name a
    // thread id whose row no longer exists, and a turn submitted into it passes every gate: the id is
    // non-null, and the thread store's create would mint the row back — resurrecting, as an empty
    // conversation, the very thing the user just erased.
    ctx.openSession(null, ctx.workingDir, analysis);

    const fate = purged.value.pages;
    // One notice carries the erase and the fate of the files. A page that stayed warns and never reads
    // as a failed delete, because the rows are gone and nothing can restore one.
    opts.notify({
        kind: fate.kind === "kept" || fate.kind === "removed" ? "info" : "warn",
        text: `Session deleted — its transcript is gone, and ${describeReportPageFate(fate)}.`,
    });
    // Re-enter through the analysis-open path: it performs exactly the landing this needs —
    // bind the surviving most-recent thread, else a fresh mint.
    await openAnalysis(ctx, analysis, opts);
}

/**
 * A thread whose archive tombstone is known to be set, so the picker can render the moment it left
 * view without a non-null assertion on a field that is absent for every live row.
 */
type ArchivedThread = ThreadSummary & { readonly archivedAt: string };

/** What one walk of the widened listing found, and whether it reached the end of the set. */
type ArchivedListing = { readonly kind: "read"; readonly threads: ArchivedThread[]; readonly truncated: boolean } | { readonly kind: "unreadable" };

/**
 * Every archived conversation in the analysis, walked page by page.
 *
 * Walking rather than reading one page is what makes the result trustworthy. The listing is widened,
 * not switched — a deliberate store decision, since a caller can narrow a widened set but cannot widen
 * an archived-only one — so the live threads come back beside the tombstoned ones, ordered by activity.
 * Archiving leaves `updated_at` where the last turn put it, so every archived row sorts BEHIND every
 * live one that has been used since: on an analysis with more conversations than a page holds, the
 * first page can contain no archived rows at all, and the picker would then state outright that there
 * are none. Being told nothing was removed is worse than a slow picker, and this is a rare, deliberate
 * action, so it pays the round trips.
 *
 * A failed page abandons the whole walk. A partial set here is indistinguishable from a complete one at
 * the call site, and the empty state it feeds makes a positive claim about the user's data.
 */
async function collectArchivedThreads(analysisId: string, opts: SessionOpts): Promise<ArchivedListing> {
    const threads: ArchivedThread[] = [];
    for (let page = 0; page < ARCHIVED_PAGE_LIMIT; page += 1) {
        const read = await opts.listThreadsWithArchived(analysisId, page);
        if (read.isErr()) return { kind: "unreadable" };
        // The predicate narrows the row type as it filters, which is what lets the picker read
        // `archivedAt` as a string rather than assert on a field absent for every live row.
        threads.push(...read.value.threads.filter((t): t is ArchivedThread => t.archivedAt !== undefined));
        if (!read.value.hasMore) return { kind: "read", threads, truncated: false };
    }
    return { kind: "read", threads, truncated: true };
}

/**
 * Open the restore picker over the analysis's archived conversations. Fetched BEFORE the dialog opens
 * for the same reason the switch picker's listing is — the thread store is an async server read that
 * a dialog body cannot pull from itself.
 *
 * A separate command rather than a toggle inside the switch picker: that picker composes a list whose
 * items are fixed for the dialog's lifetime, so a keystroke inside it could not re-render the rows,
 * and rebuilding it on a reactive list would be design-system work for a rare, deliberate action that
 * a palette entry already makes discoverable by search.
 *
 * The pre-ready refusal speaks rather than no-ops, as {@link openSwitchSession}'s does: the palette
 * hides this command until `ready`, but the leader chord dispatches by id and bypasses that predicate.
 */
export async function openRestoreSession(ctx: Workspace, opts: SessionOpts = DEFAULT_SESSION_OPTS): Promise<void> {
    const analysis = ctx.analysis;
    if (!analysis) return;
    const phase = bootState().phase;
    if (phase !== "ready" || !opts.ready()) {
        // `failed` is terminal, so "still booting" would promise a wait that never ends and contradict
        // the status bar the user is looking at. Every other non-ready phase IS a wait.
        opts.notify(
            phase === "failed"
                ? { kind: "warn", text: "The harness did not start — archived conversations are unavailable." }
                : { kind: "info", text: `Harness is still booting${GLYPHS.ellipsis}` },
        );
        return;
    }
    const listed = await collectArchivedThreads(analysis.id, opts);
    if (listed.kind === "unreadable") {
        opts.notify({ kind: "warn", text: "Could not list this analysis's archived conversations." });
        return;
    }
    const archived = listed.threads;
    // The listing is a server round trip and NOTHING is modal across it, exactly as in
    // {@link openSwitchSession}: the analysis-switch keys are still live, so a picker opened anyway
    // would offer the previous analysis's archived conversations under the current analysis's heading.
    if (ctx.analysis?.id !== analysis.id) {
        opts.notify({ kind: "info", text: "Analysis changed — reopen restore for this one." });
        return;
    }
    // After the changed-analysis refusal, not before it: the toast channel shows one notice at a time,
    // so a caveat about a listing that is no longer being offered would only displace the refusal.
    if (listed.truncated) {
        opts.notify({ kind: "warn", text: "This analysis has more conversations than the picker can walk — some archived ones are not listed." });
    }
    ctx.openDialog(() => (
        <SelectDialog
            title="Restore session"
            placeholder={`Search archived sessions${GLYPHS.ellipsis}`}
            // Durable-record rule: a listed conversation is a referenced record, so its stamp is an
            // absolute local time. The tombstone rather than the activity clock, because what tells two
            // archived conversations apart is when each one was removed — the archive leaves
            // `updatedAt` on the last turn, which can predate the removal by weeks.
            items={archived.map((t) => ({ value: t, title: threadLabel(t), description: `Removed ${new Date(t.archivedAt).toLocaleString()}` }))}
            // Removal is the only thing that puts a row here, so the empty state names it rather than
            // leaving the user to guess what this picker is ever supposed to hold.
            emptyText="No archived conversations — removing one from this analysis puts it here"
            onCancel={() => ctx.closeDialog()}
            onSelect={(t: ArchivedThread) => {
                ctx.closeDialog();
                void commitSessionRestore(analysis.id, t, opts);
            }}
        />
    ));
}

/**
 * Lift the chosen conversation's tombstone and report the outcome. Lives beside the picker rather than
 * inside its `onSelect` so the outcome ladder is testable headlessly (the {@link commitSessionRename}
 * shape); the dialog owns only the choice and its close.
 *
 * The restored thread is deliberately NOT bound to the chat. Restoring is a recovery of something the
 * user may only want back in the listing, and yanking them off the conversation they are reading to
 * land on it would be a navigation they never asked for. The notice therefore claims only what the
 * write did — the thread lists again — leaving the switch picker to open it.
 */
export async function commitSessionRestore(analysisId: string, thread: ThreadSummary, opts: SessionOpts = DEFAULT_SESSION_OPTS): Promise<void> {
    await opts.unarchiveThread(analysisId, thread.id).match(
        () => opts.notify({ kind: "info", text: `Session restored — "${threadLabel(thread)}" appears in this analysis again.` }),
        (e) => opts.notify({ kind: "error", text: `Failed: ${describeClientError(e)}` }),
    );
}

/**
 * Export an analysis's provenance into its output folder through the server — the document, and the signed
 * attestation beside a JSON export — then notify the destination. The server flushes the recorder first,
 * and it builds the attestation BEFORE either file is written, thus a signing failure writes nothing.
 *
 * Exported for the delete ladder, which exports into the live workspace before retiring it. Resolves
 * `true` only when the export landed — every failure is notified here, but a caller acting on the user's
 * behalf needs the fact as well as the toast, because the toast channel replaces what is showing with the
 * next arrival.
 */
export async function exportProvenanceToFile(a: Analysis, format: BuiltinProvFormat, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<boolean> {
    return (await createProvenanceExport(a.id, { format: format === "json" ? "prov-json" : "prov-n" }, opts)).match(
        (exported) => {
            notify({ kind: "info", text: `Wrote ${format} provenance to ${exported.path}` });
            return true;
        },
        (e) => {
            notify({ kind: "error", text: `Provenance export failed: ${describeClientError(e)}` });
            return false;
        },
    );
}

/**
 * How many runs the picker's fresh fetch pulls. A deliberate cap, not pagination — the picker's
 * fuzzy filter narrows within it, no analysis is expected to approach it, and when a fetch comes
 * back exactly at the cap the picker's title says "newest 100" so the truncation is never silent.
 */
const RUNS_PICKER_LIMIT = 100;

/**
 * Open the searchable runs picker → run-detail flow. The SINGLE open path behind all three entry
 * points (the `runs.show` palette command, the sidebar RUNS section click, and its leader chord —
 * the app routes the latter two through the command), so every door shows the identical picker.
 *
 * Fetches fresh at open (newest-first, {@link RUNS_PICKER_LIMIT}) rather than reading the sidebar
 * store's snapshot: the rail's snapshot is capped small for the poll loop, and investigation needs
 * history. Pre-ready (or on a read failure) it degrades to the muted placeholder dialog without
 * a request — the same not-ready vocabulary the rail uses. Each row carries its plan title and its
 * figure from the same read. Selecting a run STACKS the detail dialog over the picker (no
 * close-then-open, diverging from `plan.explore-steps`' one-shot lookup): dismissing the detail
 * lands back in the still-mounted picker, the right shape for inspecting several runs in a row.
 */
async function openRunsPicker(ctx: Workspace): Promise<void> {
    const analysis = ctx.analysis;
    const title = analysis ? `Runs ${GLYPHS.emDash} ${analysis.name}` : "Runs";
    if (bootState().phase !== "ready" || !analysis) {
        ctx.openDialog(() => <ResultsDialog title={title} lines={["runtime not ready"]} emptyText="runtime not ready" onClose={() => ctx.closeDialog()} />);
        return;
    }
    const rows = (await fetchRuns(analysis.id, { perPage: RUNS_PICKER_LIMIT })).match(
        (list): RunSummary[] | null => list.runs,
        () => null,
    );
    if (rows === null) {
        ctx.openDialog(() => <ResultsDialog title={title} lines={["runs unavailable"]} emptyText="runs unavailable" onClose={() => ctx.closeDialog()} />);
        return;
    }
    const atCap = rows.length === RUNS_PICKER_LIMIT;
    ctx.openDialog(() => (
        <SelectDialog
            title={atCap ? `${title} (newest ${RUNS_PICKER_LIMIT})` : title}
            placeholder={`Search runs${GLYPHS.ellipsis}`}
            items={rows.map((run) => {
                // Title first, id tail always appended: two runs of the SAME plan share a title, so
                // the tail is what tells them apart. A run whose plan is gone or predates titles falls
                // back to the workflow-name label.
                const label = run.planTitle ?? shortRunName(run);
                // A run with no ledger rows contributes NO segment rather than a zeroed one — the same
                // absent-means-not-reported rule the ledger keeps all the way down from its NULL sums.
                const figure = run.usage ? formatTokenFigure(run.usage) : "";
                return {
                    value: run,
                    // Title alone on its own (wrapping) line — plan titles run long (up to 80 chars).
                    title: label,
                    // Id tail + status + compact started date as a left-aligned second line (`meta`, not
                    // an inline `hint`): the long title would otherwise collide with the metadata mid-wrap.
                    // The id tail lives here (not the title) so two runs of one plan differ on this line.
                    // Durable-record rule — the picker lists referenced records, so absolute times; the
                    // detail line below expands the focused row to full seconds-bearing started/finished.
                    // The figure joins this line rather than claiming an inline `hint`: a row carrying
                    // `meta` ignores `hint` by contract, and the figure belongs with the run's other
                    // per-row facts anyway.
                    meta: `${idTail(run.runId)} ${GLYPHS.middot} ${run.status} ${GLYPHS.middot} ${absTimeShort(run.startedAt)}${figure ? ` ${GLYPHS.middot} ${figure}` : ""}`,
                    description: `started ${absTime(run.startedAt)}${run.completedAt ? ` ${GLYPHS.middot} finished ${absTime(run.completedAt)}` : ""}`,
                };
            })}
            emptyText="no runs"
            onCancel={() => ctx.closeDialog()}
            onSelect={(run: RunSummary) => {
                // The steps and their figures are read at SELECT, not with the rows above: this is one
                // request per run the user actually opens, where hoisting it would read every drawn
                // row's steps to serve the one row that gets picked.
                ctx.openDialog(() => <RunDetailDialog run={run} loadDetail={(runId) => fetchRun(analysis.id, runId)} onClose={() => ctx.closeDialog()} />);
            }}
        />
    ));
}

/** The single source of truth. Add a command = add an entry here. Ordered by category so the
 *  unfiltered palette groups contiguously. */
export const commands: Command[] = [
    {
        id: "analysis.switch",
        title: "Switch analysis",
        description: "Open a different analysis's chat in place",
        category: "Analysis",
        run: (ctx) => openSwitchAnalysis(ctx),
    },
    {
        id: "analysis.new",
        title: "New analysis",
        description: "Create an analysis here and open it",
        category: "Analysis",
        run: (ctx) => ctx.openDialog(() => <NewAnalysisDialog />),
    },
    {
        id: "analysis.list",
        title: "List analyses",
        description: "Show recent analyses",
        category: "Analysis",
        run: async (ctx) => {
            const analyses = await fetchAllAnalyses();
            if (analyses !== null) ctx.openDialog(() => <AnalysesListDialog analyses={analyses} />);
        },
    },
    {
        id: "analysis.rename",
        title: "Rename analysis",
        description: "Change the current analysis's name",
        category: "Analysis",
        enabled: (ctx) => ctx.analysis !== null,
        run: async (ctx) => {
            const a = ctx.analysis;
            if (!a) return;
            const busy = await workspaceBusyReason(a.id);
            if (busy) {
                notify({ kind: "warn", text: `Cannot rename while ${busy} — renaming moves the analysis's workspace folder.` });
                return;
            }
            ctx.openDialog(() => <RenameAnalysisDialog />);
        },
    },
    {
        id: "analysis.add-input",
        title: "Manage inputs",
        description: "Add or remove this analysis's input files and folders",
        category: "Analysis",
        enabled: (ctx) => ctx.analysis !== null,
        run: async (ctx) => {
            const a = ctx.analysis;
            if (!a) return;
            const inputs = await fetchAllInputs(a.id);
            if (inputs !== null) ctx.openDialog(() => <AddInputDialog inputs={inputs} />);
        },
    },
    {
        // The id stays `remove-input` though the surface now takes a batch: it is the key a user's
        // `config.keybinds` entry can already be bound to, and renaming it would silently orphan that.
        id: "analysis.remove-input",
        title: "Remove inputs",
        description: "Remove one or more inputs from this analysis",
        category: "Analysis",
        enabled: (ctx) => ctx.analysis !== null,
        run: (ctx) => openRemoveInputs(ctx),
    },
    {
        id: "analysis.reprofile",
        title: "Re-profile data",
        description: "Force a fresh data profile of this analysis's inputs",
        category: "Analysis",
        enabled: (ctx) => ctx.analysis !== null,
        run: (ctx) => {
            const a = ctx.analysis;
            if (!a) return;
            // A deliberate manual action, but the force drive needs the runtime of the server. When boot
            // has not reached ready, refuse with a notice (matching the status bar's "booting…") rather
            // than silently no-op'ing — the command is analysis-scoped via `enabled`, not boot-scoped,
            // since the predicate only sees the workspace.
            if (bootState().phase !== "ready") {
                notify({ kind: "info", text: `Harness is still booting${GLYPHS.ellipsis}` });
                return;
            }
            gatedForceReprofile(a, () => ctx.analysis?.id ?? null);
        },
    },
    {
        id: "analysis.set-project",
        title: "Set project",
        description: "Attach, move, or clear this analysis's project grouping",
        category: "Analysis",
        enabled: (ctx) => ctx.analysis !== null,
        run: async (ctx) => {
            const projects = await fetchAllProjects();
            if (projects !== null) ctx.openDialog(() => <SetProjectDialog projects={projects} />);
        },
    },
    {
        // The palette half of the transfer retry (the package-store-transfers
        // spec): the same detached children the setup and the commands start,
        // never an in-app download.
        id: "sandbox.redownload-images",
        title: "Re-download sandbox images",
        description: "Start the two detached image transfers (the runtime image and the provisioner image)",
        category: "Sandbox",
        run: async () => {
            (await createTransfer({ kind: "images" })).match(
                (response) => {
                    const started = response.starts.filter((start) => start.outcome === "started").length;
                    notify({ kind: "info", text: `${started} image transfer(s) started. Watch them in the sidebar.` });
                },
                (error) => notify({ kind: "error", text: describeClientError(error) }),
            );
        },
    },
    {
        id: "store.redownload-catalog",
        title: "Re-download package catalog",
        description: "Start the detached catalog transfer from GitHub Packages",
        category: "Sandbox",
        run: async () => {
            (await createTransfer({ kind: "catalog", update: false })).match(
                (response) => {
                    const start = response.starts[0];
                    if (start === undefined) return;
                    if (start.outcome === "started") notify({ kind: "info", text: "The catalog transfer started. Watch it in the sidebar." });
                    else if (start.outcome === "already_running") notify({ kind: "info", text: "A catalog transfer is already running." });
                    else if (start.outcome === "up_to_date") notify({ kind: "info", text: "The package store is up to date." });
                    else if (start.outcome === "failed") notify({ kind: "error", text: start.message });
                    else notify({ kind: "info", text: "A newer catalog is available. Run `inflexa store download --update` to apply it." });
                },
                (error) => notify({ kind: "error", text: describeClientError(error) }),
            );
        },
    },
    {
        // The keyboard half of the failed-flight detail (the
        // package-store-management spec): the sidebar row answers a click, and
        // this entry serves the keyboard through a picker of the failed rows.
        id: "store.failed-flights",
        title: "Failed package flights",
        description: "Open a failed acquisition flight: the recorded reason, with copy, retry, and delete",
        category: "Sandbox",
        // The client cache of the store poll: an `enabled` predicate re-evaluates per render, thus it
        // must not send a request.
        enabled: () => storeFlightLines().some((flight) => flight.state === "failed"),
        run: (ctx) => {
            const failed = storeFlightLines().filter((flight) => flight.state === "failed");
            const first = failed[0];
            if (first === undefined) {
                notify({ kind: "info", text: "No failed package flight." });
                return;
            }
            if (failed.length === 1) {
                ctx.openDialog(() => <FailedFlightDialog flight={first} onClose={() => ctx.closeDialog()} />);
                return;
            }
            ctx.openDialog(() => (
                <SelectDialog
                    title="Failed package flights"
                    placeholder={`Search flights${GLYPHS.ellipsis}`}
                    items={failed.map((flight) => ({ value: flight.id, title: flight.spec }))}
                    emptyText="No failed flights"
                    onCancel={() => ctx.closeDialog()}
                    onSelect={(id: string) => {
                        ctx.closeDialog();
                        const row = failed.find((candidate) => candidate.id === id);
                        if (row !== undefined) ctx.openDialog(() => <FailedFlightDialog flight={row} onClose={() => ctx.closeDialog()} />);
                    }}
                />
            ));
        },
    },
    {
        id: "analysis.delete",
        title: "Delete analysis",
        description: "Delete this analysis and its input refs; choose whether to keep its files",
        category: "Analysis",
        enabled: (ctx) => ctx.analysis !== null,
        run: async (ctx) => {
            const a = ctx.analysis;
            if (!a) return;
            // Gated BEFORE the quiescence check and both dialogs: the server cannot purge without the
            // booted runtime and will refuse anyway, so asking the user to type the analysis's name and
            // choose a disposal first would spend their confirmation on a refusal.
            if (bootState().phase !== "ready") {
                notify({ kind: "warn", text: DELETE_NEEDS_HARNESS });
                return;
            }
            const busy = await workspaceBusyReason(a.id);
            if (busy) {
                notify({ kind: "warn", text: `Cannot delete while ${busy} — deleting retires the analysis's workspace folder.` });
                return;
            }
            ctx.openDialog(() => (
                <ConfirmDeleteDialog
                    entityLabel="analysis"
                    entityName={a.name}
                    onConfirm={() => {
                        ctx.openDialog(() => <DeleteAnalysisFilesDialog analysis={a} onDecided={(disposal) => void deleteAnalysisWith(ctx, a, disposal)} />);
                    }}
                />
            ));
        },
    },
    {
        id: "analysis.open-output",
        title: "Open output folder",
        description: "Reveal this analysis's output directory",
        category: "Analysis",
        enabled: (ctx) => ctx.analysis !== null,
        run: async (ctx) => {
            const a = ctx.analysis;
            if (!a) return;
            // The server makes the folder when it does not exist yet; this process opens it.
            (await createOutputDir(a.id)).match(
                ({ path }) => {
                    // Fire-and-forget reveal: a missing opener is not worth an error — the toast names the folder.
                    openExternal(path).match(
                        () => undefined,
                        () => undefined,
                    );
                    notify({ kind: "info", text: `Opened ${path}` });
                },
                // An unusable folder carries the folder and the remedy — print it verbatim.
                (e) => notify({ kind: "error", text: clientErrorText(e) }),
            );
        },
    },
    {
        id: "prov.export-json",
        title: "Export provenance (JSON)",
        description: "Write this analysis's PROV-JSON provenance to its output folder",
        category: "Analysis",
        enabled: (ctx) => ctx.analysis !== null,
        run: async (ctx) => {
            const a = ctx.analysis;
            if (!a) return;
            await exportProvenanceToFile(a, "json");
        },
    },
    {
        id: "prov.export-provn",
        title: "Export provenance (PROV-N)",
        description: "Write this analysis's PROV-N provenance to its output folder",
        category: "Analysis",
        enabled: (ctx) => ctx.analysis !== null,
        run: async (ctx) => {
            const a = ctx.analysis;
            if (!a) return;
            await exportProvenanceToFile(a, "provn");
        },
    },
    {
        id: "prov.verify",
        title: "Verify provenance (internal)",
        description: "Check the integrity of the database provenance record",
        category: "Analysis",
        enabled: (ctx) => ctx.analysis !== null,
        run: async (ctx) => {
            const a = ctx.analysis;
            if (!a) return;

            // The kernel is loaded lazily: it pulls tsprov behind it, which the palette does not need at start.
            let kernel: typeof import("@inflexa-ai/prov-kernel");
            try {
                kernel = await import("@inflexa-ai/prov-kernel");
            } catch {
                notify({ kind: "error", text: "Provenance verification is unavailable." });
                return;
            }

            (await fetchProvenanceVerification(a.id)).match(
                (result) => notify({ kind: noticeKindFor(result), text: kernel.formatVerifyResult(result) }),
                (e) => notify({ kind: "error", text: `Could not read provenance data: ${describeClientError(e)}` }),
            );
        },
    },
    {
        id: "prov.verify-export",
        title: "Verify provenance (export)",
        description: "Check the integrity of the exported provenance files on disk",
        category: "Analysis",
        enabled: (ctx) => ctx.analysis !== null,
        run: async (ctx) => {
            const a = ctx.analysis;
            if (!a) return;

            // Client work (draft 6.2): the server names where the export is, and this process reads the file and
            // its attestation, the same as `prov verify-file`. The verifier and the kernel load lazily: they pull
            // tsprov behind them.
            let verify: typeof import("../modules/prov/verify_file.ts");
            let kernel: typeof import("@inflexa-ai/prov-kernel");
            try {
                verify = await import("../modules/prov/verify_file.ts");
                kernel = await import("@inflexa-ai/prov-kernel");
            } catch {
                notify({ kind: "error", text: "Provenance verification is unavailable." });
                return;
            }

            const resolved = (await resolveArtifacts(a.id, { entries: [{ kind: "workspace-file", path: "provenance.json" }], materialize: false })).match(
                ({ entries: [entry] }) => entry ?? null,
                () => null,
            );
            if (resolved === null || resolved.path === null) {
                notify({ kind: "error", text: "Could not resolve this analysis's output directory." });
                return;
            }
            if (resolved.degraded) {
                notify({ kind: "warn", text: "No exported provenance.json found. Export provenance first." });
                return;
            }

            const result = await verify.verifyExportFile(resolved.path);
            if (!result) {
                notify({ kind: "warn", text: "No .sig.json attestation found. The export may be unsigned." });
                return;
            }
            notify({ kind: noticeKindFor(result), text: kernel.formatVerifyResult(result) });
        },
    },
    // The session commands are boot-gated: thread metadata lives only in Postgres, so before `ready`
    // there is nothing to list, retitle, remove, restore, or erase — offering them then would promise a
    // surface that cannot answer. Rename, remove and delete additionally need a bound thread to act on;
    // restore acts on a thread the user picks, so an unbound scope is no obstacle to it.
    {
        id: "session.switch",
        title: "Switch session",
        description: "Switch to another session in this analysis",
        category: "Session",
        enabled: (ctx) => ctx.analysis !== null && bootState().phase === "ready",
        run: (ctx) => openSwitchSession(ctx),
    },
    {
        id: "session.report-switch",
        title: "Switch report session",
        description: "Switch to a report session this conversation spawned",
        category: "Session",
        // Gated with its siblings, and for their reason: thread metadata lives only in Postgres. The
        // bound thread is deliberately NOT part of the gate — the flow names an unbound scope itself,
        // where hiding the command would leave a user who searched for it with no answer at all.
        enabled: (ctx) => ctx.analysis !== null && bootState().phase === "ready",
        run: (ctx) => openSwitchReportSession(ctx),
    },
    {
        id: "session.new",
        title: "New session",
        description: "Start a new conversation in this analysis",
        category: "Session",
        // Gated like its siblings, but for its own reason: the mint needs nothing from Postgres, yet a
        // pre-`ready` chat cannot send the turn that gives the fresh id a row, and binding a mint early
        // would suppress the ready-edge resolution that opens the most-recent thread.
        enabled: (ctx) => ctx.analysis !== null && bootState().phase === "ready",
        run: (ctx) => newSessionFlow(ctx),
    },
    {
        id: "session.rename",
        title: "Rename session",
        description: "Change the current session's title",
        category: "Session",
        enabled: (ctx) => ctx.sessionId !== null && bootState().phase === "ready",
        run: (ctx) => openRenameSession(ctx),
    },
    {
        id: "session.copy-id",
        title: "Copy session id",
        description: "Copy the open session's full id to the clipboard",
        category: "Session",
        // The one session command with no boot gate, and it needs none: the id is minted into the
        // workspace scope, so a bound thread is the whole precondition and Postgres is not consulted.
        // The SESSION chip is the same act by mouse; this is its keyboard door.
        enabled: (ctx) => ctx.sessionId !== null,
        run: (ctx) => {
            const threadId = ctx.sessionId;
            if (threadId === null) return;
            // Best-effort by contract, so it never rejects — notify optimistically, as every other
            // copy in the app does, and in the words the chip uses so one act reads as one act.
            void writeClipboard(threadId);
            notify({ kind: "info", text: "Copied to clipboard" });
        },
    },
    {
        id: "session.delete",
        // Titled for what it does, while the id stays `session.delete` — the id is the stable handle
        // keybinds and tests bind to, and re-keying it to match the copy would break them for nothing.
        title: "Remove session",
        description: "Remove the current session from this analysis's conversations (the transcript is kept)",
        category: "Session",
        enabled: (ctx) => ctx.analysis !== null && ctx.sessionId !== null && bootState().phase === "ready",
        run: (ctx) => deleteSessionFlow(ctx),
    },
    {
        id: "session.restore",
        title: "Restore session",
        description: "Bring a removed session back into this analysis's conversations",
        category: "Session",
        enabled: (ctx) => ctx.analysis !== null && bootState().phase === "ready",
        run: (ctx) => openRestoreSession(ctx),
    },
    {
        id: "session.purge",
        // The description carries the whole weight of telling this apart from "Remove session", which
        // sits beside it under the same category: the titles differ by one word, and only one of these
        // two actions can be undone.
        title: "Delete session",
        description: "Permanently erase the current session and every message in it — this cannot be undone",
        category: "Session",
        enabled: (ctx) => ctx.analysis !== null && ctx.sessionId !== null && bootState().phase === "ready",
        run: (ctx) => purgeSessionFlow(ctx),
    },
    {
        id: "project.new",
        title: "New project",
        description: "Create a project grouping",
        category: "Project",
        run: (ctx) => ctx.openDialog(() => <NewProjectDialog />),
    },
    {
        id: "project.list",
        title: "List projects",
        description: "Show all projects with analysis counts",
        category: "Project",
        run: async (ctx) => {
            const projects = await fetchAllProjects();
            if (projects !== null) ctx.openDialog(() => <ProjectListDialog projects={projects} />);
        },
    },
    {
        id: "project.delete",
        title: "Delete project",
        description: "Delete a project (analyses are ungrouped, not deleted)",
        category: "Project",
        run: async (ctx) => {
            const projects = await fetchAllProjects();
            if (projects === null) return;
            ctx.openDialog(() => (
                <SelectDialog
                    title="Delete project"
                    placeholder={`Select project to delete${GLYPHS.ellipsis}`}
                    items={projects.map((p) => ({ value: p, title: p.name, description: p.description ?? undefined }))}
                    emptyText="No projects"
                    onCancel={() => ctx.closeDialog()}
                    onSelect={(p: ProjectSummary) => {
                        ctx.closeDialog();
                        ctx.openDialog(() => (
                            <ConfirmDeleteDialog
                                entityLabel="project"
                                entityName={p.name}
                                onConfirm={() => {
                                    void deleteProject(p.id).match(
                                        () => notify({ kind: "info", text: `Deleted project "${p.name}"` }),
                                        (e) =>
                                            notify(
                                                e.type === "http" && e.status === 404
                                                    ? { kind: "warn", text: "Project not found." }
                                                    : { kind: "error", text: clientErrorText(e) },
                                            ),
                                    );
                                }}
                            />
                        ));
                    }}
                />
            ));
        },
    },
    {
        id: "auth.whoami",
        title: "Show identity",
        description: "Show the logged-in user and session status",
        category: "App",
        run: (ctx) => openIdentity(ctx),
    },
    {
        id: "view.status",
        title: "Show status",
        description: "What inflexa resolves to here, plus the model connection",
        category: "View",
        run: async (ctx) => {
            const contextLine = (await resolveAnalysisContext({ cwd: ctx.workingDir })).match(
                (c) => c.describe,
                (e) => `Failed to resolve context: ${clientErrorText(e)}`,
            );
            ctx.openDialog(() => <StatusDialog contextLine={contextLine} />);
        },
    },
    {
        id: "view.theme",
        title: "Change theme",
        description: "Pick a color theme",
        category: "View",
        run: (ctx) => ctx.openDialog(() => <ThemePicker />),
    },
    {
        id: "view.settings",
        title: "Settings",
        description: "Open settings",
        category: "View",
        run: (ctx) => openSettings(ctx),
    },
    {
        // The panel's chord is a toggle; this command is restore-ONLY. A user reaches the palette
        // precisely because they lost the panel and do not recall the chord, so a toggle here could
        // hide it a second time and read as the command having done nothing.
        id: "view.activity-panel",
        title: "Show activity panel",
        description: "Bring back the live activity panel",
        category: "View",
        run: () => restoreActivityPanel(),
    },
    {
        id: "view.design-gallery",
        title: "Design gallery",
        description: "Preview every stream-block state",
        category: "View",
        run: (ctx) => ctx.openDialog(() => <DesignGallery onClose={ctx.closeDialog} />),
    },
    {
        id: "artifact.browse",
        title: "Browse artifacts…",
        description: "Open a chart, figure, file, or report shown in this session",
        category: "View",
        run: async (ctx) => {
            const analysis = ctx.analysis;
            const openables = analysis ? sessionOpenables(analysis.id) : [];
            // One request resolves each path. A failed resolution still opens the picker, and a row
            // with no path shows the caption of its entry.
            const paths =
                analysis && openables.length > 0
                    ? (await resolveArtifacts(analysis.id, { entries: openables.map((o) => o.entry.target), materialize: false })).match(
                          ({ entries }) => entries.map((entry) => entry.path),
                          () => [],
                      )
                    : [];
            const items = openables.map((openable, i) => ({
                value: openable,
                title: openable.entry.name,
                description: paths[i] ?? openable.entry.caption,
            }));
            ctx.openDialog(() => <BrowseArtifactsDialog items={items} />);
        },
    },
    {
        id: "plan.explore-steps",
        title: "Explore plan steps…",
        description: "Inspect the latest plan's questions, constraints, and resources",
        category: "View",
        keybind: keybindLabel("plan.explore-steps"),
        enabled: () => latestPlanCard() !== null,
        run: (ctx) => {
            const plan = latestPlanCard();
            if (!plan) return;
            ctx.openDialog(() => (
                <SelectDialog
                    title="Plan steps"
                    items={plan.steps.map((step) => ({ value: step, title: `${step.id} ${step.name}`, hint: step.agent }))}
                    emptyText="No plan steps"
                    onCancel={ctx.closeDialog}
                    onSelect={(step) => {
                        ctx.closeDialog();
                        ctx.openDialog(() => <PlanStepDetailDialog step={step} onClose={ctx.closeDialog} />);
                    }}
                />
            ));
        },
    },
    {
        id: "runs.show",
        title: "Show runs",
        description: "Pick a run to inspect its status, timing, and steps",
        category: "View",
        // Gated on the booted runtime: the picker's fresh fetch needs the runtime of the server. The open
        // path itself still degrades pre-ready (the sidebar entry points bypass this predicate).
        enabled: (ws) => bootState().phase === "ready" && ws.analysis !== null,
        run: (ctx) => void openRunsPicker(ctx),
    },
    // The model-switch commands form their own `Provider` group — declared here, after `View`, so
    // the palette (which orders groups by a category's first appearance in this array) renders it as
    // its own section near the end rather than folded into the display/settings `View` group.
    {
        id: "model.switch-chat",
        title: "Switch chat model",
        description: "Choose the model the chat agent (and its sub-agents) runs on",
        category: "Provider",
        run: (ctx) => openModelPicker(ctx, "conversation"),
    },
    {
        id: "model.switch-sandbox",
        title: "Switch sandbox model",
        description: "Choose the model runs, data profiling, and the sandbox agents use",
        category: "Provider",
        run: (ctx) => openModelPicker(ctx, "sandbox"),
    },
    {
        id: "model.switch-utility",
        title: "Switch utility model",
        description: "Choose the model used for bounded routing and classification work",
        category: "Provider",
        run: (ctx) => openModelPicker(ctx, "utility"),
    },
    {
        id: "app.quit",
        title: "Quit",
        description: "Exit inflexa",
        category: "App",
        // Display-only: ctrl+c (the abort chord) doubles as the exit affordance shown in the palette.
        keybind: keybindLabel("app.abort"),
        run: (ctx) => {
            void ctx.quit();
        },
    },
];
