import { createSignal, Show, type JSX } from "solid-js";
import { randomUUIDv7 } from "bun";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { ResultAsync } from "neverthrow";
// Type-only — erased at compile time, so it does NOT pull tsprov/verify into the TUI's startup path.
import type { BuiltinProvFormat } from "@inflexa-ai/tsprov";
import type { VerifyResult } from "../types/prov.ts";

import { PromptDialog } from "./components/dialog/prompt_dialog.tsx";
import { ResultsDialog } from "./components/dialog/results_dialog.tsx";
import { SelectDialog } from "./components/dialog/select_dialog.tsx";
import type { SelectItem } from "./components/list_core.tsx";
import { PlanStepDetailDialog } from "./components/dialog/plan_step_detail_dialog.tsx";
import { RunDetailDialog, type RunStepUsage } from "./components/dialog/run_detail_dialog.tsx";
import { FilePicker } from "./components/dialog/file_picker.tsx";
import { ConfigApp } from "./app_config.tsx";
import { DesignGallery } from "./layout/design_gallery.tsx";
import { setTheme, theme, type Notice } from "./theme.ts";
import { notify } from "./hooks/notice.ts";
import { createThreadStore, loadPlan, queryActiveRunsByAnalysis, queryRunsByAnalysis, queryStepsByRun } from "@inflexa-ai/harness";
import type { AnalysisPurgeOutcome, CortexRunRow, DbError, Pool, Thread, ThreadPage } from "@inflexa-ai/harness";

import { agentModels, bootState, harnessRuntime } from "./hooks/boot.ts";
import { refreshOpenThread, resolveThreadId } from "./hooks/thread.ts";
import { latestPlanCard, sessionOpenables, type SessionOpenable } from "./hooks/conversation.ts";
import { openArtifact } from "./hooks/artifacts.ts";
import { resolveEntryPath } from "../modules/harness/artifact_open.ts";
import { driveForceReprofile, profileWorkInFlight } from "./hooks/profile_parity.ts";
import { absTime, absTimeShort, idTail, shortRunName } from "./hooks/sidebar_live.ts";
import { restoreActivityPanel } from "./hooks/activity_panel.ts";
import { chatStatus } from "./hooks/status.ts";
import { chordLabel, keybindLabel, type Chord } from "./keymap.ts";
import { useWorkspace, type Workspace } from "./contexts/workspace.ts";
import type { HarnessRuntime } from "../modules/harness/runtime.ts";
import { GLYPHS, themes, themeIds, type ThemeId } from "../lib/design_system.ts";
import { readConfig, writeConfig } from "../lib/config.ts";
import { mkdirResult, statResult, writeFileResult } from "../lib/fs.ts";
import { str256, type Str256 } from "../lib/types.ts";
import {
    createAnalysis,
    listRecentAnalyses,
    renameAnalysisAndMoveWorkspace,
    applyInputsDiff,
    removeInput,
    matchAnalysis,
} from "../modules/analysis/analysis.ts";
import { writeAgentModel, type AgentName } from "../modules/harness/config.ts";
import { analysisPurgeFor } from "../modules/harness/purge.ts";
import { listConnectionModels, validateModelSelection } from "../modules/harness/model_listing.ts";
import type { ModelAccess } from "../modules/proxy/models.ts";
import { currentAgentModels, requestAgentModelChange } from "../modules/harness/agent_switch.ts";
import { resolveInputPath } from "../modules/analysis/input.ts";
import { resolveContext, describeContext } from "../modules/analysis/context.ts";
import { openOutputDir } from "../modules/analysis/open.ts";
import { archivedOutputSubdir, defaultOutputSubdir, disposeWorkspace, locateExistingOutputDir, resolveOutputDir } from "../modules/analysis/output.ts";
import { resolveAnchor, resolvedPathOrCached } from "../modules/anchor/anchor.ts";
import { canonicalPath } from "../modules/anchor/marker.ts";
import { loadAuth, describeAuthError } from "../modules/auth/auth.ts";
import { decodeIdTokenClaims } from "../modules/auth/whoami.ts";
import { createProject, deleteAnalysis, deleteProject, updateAnalysisProject } from "../db/primary_mutation.ts";
import {
    listProjects,
    listAnalysisInputs,
    listAnchors,
    countAnalysesByProject,
    listAnalysisUsageByRun,
    listRunUsageByStep,
    listUsageTotalsByAnalysis,
    type LlmUsageTotals,
} from "../db/primary_query.ts";
import { contractHome } from "../lib/paths.ts";
import { writeClipboard } from "../lib/clipboard.ts";
import { useDialogBindings } from "./components/dialog/dialog_host.tsx";
import { formatTokenFigure } from "../lib/usage_format.ts";
import type { Analysis, AnalysisInput } from "../types/analysis.ts";
import type { Project } from "../types/project.ts";

// The command registry: the SINGLE source of truth for the palette. Adding a command is one
// entry in `commands`. Each command's `run` acts only through the `Workspace` (the context store
// built in `App`), never stdout — the alt-screen owns the terminal. Command-specific dialogs are
// co-located here as single-caller helpers; the reusable dialog shells live in `components/`.

/** The categories a command groups under in the palette. A domain type, never a raw string. */
export type CommandCategory = "Analysis" | "Session" | "Project" | "View" | "Provider" | "App";

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

// Resolve an analysis's live working directory from its anchor (falling back to cwd).
function workingDirFor(a: Analysis): string {
    return resolveAnchor(a.anchorId).match(
        (resolved) => resolvedPathOrCached(resolved) ?? process.cwd(),
        () => process.cwd(),
    );
}

/**
 * Why the analysis's workspace directory must not move or be retired right now, phrased to finish
 * "Cannot X while …". Null when it may.
 *
 * Renaming moves the tree; deleting archives or removes it. The harness's `resolveWorkspaceRoot`
 * hands out paths beneath that tree for the whole life of a run, and the per-analysis instance lock
 * is no defence — it excludes other PROCESSES, while every run of this analysis executes inside
 * this one. Three things can be holding the tree: a streaming chat turn, a queued/running data
 * profile, or a durable run that outlived the turn that launched it (`execute_analysis` returns before
 * its workflow does). Checked once, before the dialog opens: a modal blocks the composer, so no
 * new work can start between the check and the action.
 *
 * The ledger read asks for the analysis's ACTIVE runs rather than a page of its recent ones. A paged
 * read answers "is anything in flight" only while every live run happens to fall inside the window,
 * so a long-abandoned `running` row on an analysis with a busy history since would pass the gate.
 * This gate also carries the delete flow's quiescence precondition — a purge is not serialized
 * against a run starting under it — and that is not a question a bounded window can answer. The
 * active set is capped by live concurrency rather than by history, so it needs no bound.
 */
async function workspaceBusyReason(analysisId: string): Promise<string | null> {
    if (chatStatus() === "busy") return "a chat turn is running";
    if (profileWorkInFlight()) return "a data profile is running";

    const runtime = harnessRuntime();
    // Nothing booted ⇒ no workflow in this process can hold the tree.
    if (!runtime) return null;

    return (await queryActiveRunsByAnalysis(runtime.pool, analysisId)).match(
        (runs) => (runs.length > 0 ? "a run is in flight" : null),
        // Refuse rather than guess: an unreadable ledger cannot prove the workspace is idle.
        () => "the run ledger is unreadable, so the workspace cannot be confirmed idle",
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
 * Injectable edges for the session flows (switch / rename / delete) and the in-place analysis open,
 * so each is unit-testable offline — no Postgres, no booted runtime, no toast overlay. Mirrors
 * `ThreadSeams` in `hooks/thread.ts`: production callers omit the argument and get the real booted
 * runtime, the harness thread store, and the live notice channel.
 */
export type SessionSeams = {
    /** The booted runtime handle, or `null` when boot is not ready. Real: {@link harnessRuntime}. */
    readonly runtime: () => HarnessRuntime | null;
    /** An analysis's live threads, most-recently-active first. Real: `createThreadStore(pool).listThreads`. */
    readonly listThreads: (pool: Pool, analysisId: string) => ResultAsync<ThreadPage, DbError>;
    /** One thread's row, or `null` when absent/soft-deleted. Real: `createThreadStore(pool).getThread`. */
    readonly getThread: (pool: Pool, threadId: string) => ResultAsync<Thread | null, DbError>;
    /** Retitle a thread; `null` when the row is gone. Real: `createThreadStore(pool).updateTitle`. */
    readonly updateTitle: (pool: Pool, threadId: string, title: string) => ResultAsync<Thread | null, DbError>;
    /**
     * One page of an analysis's threads WIDENED to include the archived ones — the store widens the set
     * rather than switching to an archived-only one, so a caller wanting the tombstoned rows alone
     * narrows on `deletedAt` itself. Real: `createThreadStore(pool).listThreads` with `includeArchived`.
     *
     * The page index is a parameter because the caller must be able to walk the whole set: the widened
     * listing orders by activity, and archiving leaves `updated_at` where the last turn put it, so the
     * tombstoned rows sort BEHIND every live one and a single page can hold none of them.
     */
    readonly listThreadsWithArchived: (pool: Pool, analysisId: string, page: number) => ResultAsync<ThreadPage, DbError>;
    /**
     * Archive a thread: stamp its tombstone so it stops listing, keeping the row and every message.
     * Real: `createThreadStore(pool).archiveThread`.
     */
    readonly archiveThread: (pool: Pool, threadId: string) => ResultAsync<void, DbError>;
    /** Lift a thread's tombstone so it lists again. Real: `createThreadStore(pool).unarchiveThread`. */
    readonly unarchiveThread: (pool: Pool, threadId: string) => ResultAsync<void, DbError>;
    /**
     * Erase a thread: its metadata row AND every one of its messages, with nothing left to restore.
     * The one thread verb the archive cannot undo. Real: `createThreadStore(pool).purgeThread`.
     */
    readonly purgeThread: (pool: Pool, threadId: string) => ResultAsync<void, DbError>;
    /**
     * Whether a chat turn is streaming into the open conversation right now. The harness's thread store
     * cannot observe a host's in-flight turns, so refusing an unrecoverable thread write while one is
     * running is the host's obligation. Real: `chatStatus() === "busy"`.
     */
    readonly chatBusy: () => boolean;
    /** Pick the thread to open for an analysis — most recent, else a fresh mint. Real: {@link resolveThreadId}. */
    readonly resolveThreadId: (analysisId: string) => Promise<string | null>;
    /** An analysis's live working directory. Real: {@link workingDirFor}. */
    readonly workingDirFor: (a: Analysis) => string;
    /** Re-read the open thread's row into the sidebar snapshot. Real: {@link refreshOpenThread}. */
    readonly refreshThread: (threadId: string) => void;
    /** Raise a transient toast. Real: {@link notify}. Injected so refusals and degrades are observable. */
    readonly notify: (notice: Notice) => void;
};

const realSessionSeams: SessionSeams = {
    runtime: harnessRuntime,
    listThreads: (pool, analysisId) => createThreadStore(pool).listThreads({ analysisId }),
    getThread: (pool, threadId) => createThreadStore(pool).getThread(threadId),
    updateTitle: (pool, threadId, title) => createThreadStore(pool).updateTitle(threadId, title),
    listThreadsWithArchived: (pool, analysisId, page) =>
        createThreadStore(pool).listThreads({ analysisId, includeArchived: true, page, perPage: ARCHIVED_PAGE_SIZE }),
    archiveThread: (pool, threadId) => createThreadStore(pool).archiveThread(threadId),
    unarchiveThread: (pool, threadId) => createThreadStore(pool).unarchiveThread(threadId),
    purgeThread: (pool, threadId) => createThreadStore(pool).purgeThread(threadId),
    chatBusy: () => chatStatus() === "busy",
    resolveThreadId,
    workingDirFor,
    refreshThread: (threadId) => void refreshOpenThread(threadId),
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
export async function openAnalysis(ws: Workspace, a: Analysis, seams: SessionSeams = realSessionSeams): Promise<void> {
    const mine = ++openGeneration;
    const threadId = await seams.resolveThreadId(a.id);
    if (mine !== openGeneration) return;
    ws.openSession(threadId, seams.workingDirFor(a), a);
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
        case "invalid-sidecar":
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
 * Persist an agent's model pick to `models.agents.<agent>` (durable the instant it is
 * made), then hand it to the live runtime — which applies it immediately when idle or schedules it behind
 * in-flight agent work — and surface the outcome. Config is the source of truth, so a write failure stops
 * BEFORE any runtime change it would disagree with (next boot would only revert it).
 */
function applyAgentSelection(agent: AgentName, model: string): void {
    writeAgentModel(agent, model).match(
        () => {
            const outcome = requestAgentModelChange(agent, model);
            notify(
                outcome.status === "applied"
                    ? { kind: "info", text: `${agentLabel(agent)} model: ${model}` }
                    : { kind: "info", text: `${agentLabel(agent)} model set to ${model} — applies when agent work settles` },
            );
        },
        (e) => notify({ kind: "error", text: `Failed to save model: ${e.type}` }),
    );
}

/**
 * The commit decision for a validated model pick — PURE, so the "reject in-dialog vs persist" rule is
 * unit-testable without a live dialog. A definite `not_found` keeps the picker open with an inline error
 * naming the model and the account-accessibility cause (design D6); `served` and `inconclusive` both
 * persist (inconclusive-accept: an absent/flaky validation route never blocks a switch — spec).
 */
export function modelCommitDecision(model: string, access: ModelAccess): { persist: true } | { persist: false; error: string } {
    if (access === "not_found") return { persist: false, error: `This account cannot serve ${model}. Pick another model, or check your credential.` };
    return { persist: true };
}

/**
 * Orchestrate one commit attempt: validate `model`, then either persist it or surface the inline error,
 * per {@link modelCommitDecision}. Extracted from {@link ModelPickerDialog} so the full validate→decide
 * flow is testable headlessly with injected effects; the dialog supplies only the effects and owns the
 * busy/error rendering around this call.
 */
export async function runModelCommit(
    model: string,
    effects: { validate: (model: string) => Promise<ModelAccess>; persist: (model: string) => void; reportError: (message: string) => void },
): Promise<void> {
    const decision = modelCommitDecision(model, await effects.validate(model));
    if (decision.persist) effects.persist(model);
    else effects.reportError(decision.error);
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
export function modelPickerItems(models: readonly string[], current: string): SelectItem<string>[] {
    return [
        ...models.map((id) => ({ value: id, title: id, hint: id === current ? "current" : undefined })),
        { value: MANUAL_MODEL_SENTINEL, title: `Enter a model id manually${GLYPHS.ellipsis}`, pinned: true },
    ];
}

/**
 * The agent-parameterized model picker: a {@link SelectDialog} over the connection's live models with the
 * agent's CURRENT model marked, degrading to a {@link PromptDialog} free-text entry when listing failed
 * (`models === null`). A pinned manual-entry row ({@link modelPickerItems}) opens that same free-text field
 * even when a listing IS present — so an id the connection does not enumerate stays reachable, mirroring
 * direct-setup, which always prompts free text — and esc there returns to the list rather than closing the
 * picker, since the row was reached FROM it. A committed pick (listed OR free-text) is
 * accessibility-validated (design D6)
 * before it persists — while checking, the picker shows a busy {@link PromptDialog}; a definite
 * `not_found` keeps it open with an inline error naming the model; `served`/`inconclusive` persist + close.
 *
 * The busy and inline-error affordances are PromptDialog's ONLY — {@link SelectDialog} has neither — so
 * the validation phase renders as a PromptDialog regardless of which surface the pick came from. A listed
 * pick therefore CONVERGES onto that same prompt (id pre-filled) rather than growing a bespoke list busy/
 * error state, which the design-gallery rule forbids inventing. The picking-phase surfaces are unchanged,
 * so the inert design-gallery/test exhibits render exactly as before (`validate` is never reached at rest).
 */
export function ModelPickerDialog(props: {
    agent: AgentName;
    /** The connection's model ids, or `null` when listing failed (degrade to free-text entry). */
    models: readonly string[] | null;
    /** The agent's currently-running model, marked `current` in the list and pre-filled in the listing-failure free-text field. */
    current: string;
    /** Accessibility-validate a committed id before persisting (design D6); the picker renders the busy/error phases around it. */
    validate: (model: string) => Promise<ModelAccess>;
    /** Persist + apply an accepted model, then close. */
    onCommit: (model: string) => void;
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

    function commit(raw: string): void {
        const id = raw.trim();
        if (!id) {
            notify({ kind: "warn", text: "A model id is required." });
            return;
        }
        setPending(id);
        setErrorText("");
        setPhase("checking");
        void runModelCommit(id, {
            validate: props.validate,
            persist: (accepted) => {
                // Drop out of `checking` BEFORE onCommit closes: the busy close-guard vetoes even a
                // programmatic commit close (dialog_host `dialogClose`), and PromptDialog's guard reads
                // `busy` (= phase === "checking") LIVE — so clearing the phase first lets the close through.
                setPhase("picking");
                props.onCommit(accepted);
            },
            reportError: (message) => {
                setErrorText(message);
                setPhase("error");
            },
        });
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
                            <text fg={theme().fgMuted}>
                                {props.models
                                    ? "Enter an id this connection does not list — it is checked against your account before it applies."
                                    : "Could not list the connection's models — enter a model id manually."}
                            </text>
                        )}
                        // Back to the list, not out of the picker: this prompt was reached FROM the list, so esc
                        // means "I didn't want manual entry after all". With no list there is nowhere to go back to.
                        onBack={props.models ? () => setManual(false) : undefined}
                        onCancel={props.onCancel}
                        onSubmit={commit}
                    />
                }
            >
                {(models: readonly string[]) => (
                    <SelectDialog
                        title={title()}
                        placeholder={`Search models${GLYPHS.ellipsis}`}
                        items={modelPickerItems(models, props.current)}
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
 * Open the model picker for `agent`. Boot-gated like `analysis.reprofile` (the picker needs the live
 * runtime to apply against, and the listing hits the connection endpoint): refuse with a notice while
 * booting rather than a silent no-op. Resolves the connection's models UNCACHED (`null` on failure →
 * free-text mode) before opening, then hands the picker the current model to mark.
 */
async function openModelPicker(ctx: Workspace, agent: AgentName): Promise<void> {
    if (bootState().phase !== "ready" || !harnessRuntime()) {
        notify({ kind: "info", text: `Harness is still booting${GLYPHS.ellipsis}` });
        return;
    }
    const current = currentAgentModels()[agent];
    const models = (await listConnectionModels()).match(
        (ids): readonly string[] | null => ids,
        () => null,
    );
    ctx.openDialog(() => (
        <ModelPickerDialog
            agent={agent}
            models={models}
            current={current}
            validate={(model) => validateModelSelection(model)}
            onCommit={(model) => {
                ctx.closeDialog();
                applyAgentSelection(agent, model);
            }}
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
                        createProject({ name, description: null, tags: [] }).match(
                            (p) => notify({ kind: "info", text: `Created project "${p.name}"` }),
                            (e) =>
                                notify({
                                    kind: "error",
                                    text: e.type === "constraint_violation" ? `A project named "${raw.trim()}" already exists.` : `Failed: ${e.type}`,
                                }),
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
                // The picker's selection rides in as `inputPaths` so the new analysis is seeded with
                // exactly the files the user chose — `createAnalysis` enrolls nothing on its own.
                createAnalysis({ cwd: ws.workingDir, name: props.name, inputPaths: paths }).match(
                    (a) => {
                        void openAnalysis(ws, a);
                        notify({ kind: "info", text: `Created analysis "${a.name}"` });
                    },
                    (e) => notify({ kind: "error", text: `Failed: ${e.type}` }),
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

/**
 * The analysis switcher — and the ONE place the interface reports a whole-analysis total.
 *
 * Every other surface reports the entity it names or the open working context; this is where analyses
 * are compared, which is the only question an analysis-wide total answers. Its figures come from ONE
 * batched ledger read over the listed ids (never a query per drawn row) against the CLI's own local
 * SQLite, so the picker still opens with the harness runtime cold.
 *
 * A failed usage read degrades to no figures at all: a picker that cannot switch analyses because a
 * bookkeeping read failed is a far worse outcome than a picker with no figures.
 */
function SwitchAnalysisDialog(): JSX.Element {
    const ws = useWorkspace();
    const analyses = listRecentAnalyses().match(
        (as) => as,
        () => [],
    );
    const usageByAnalysis = listUsageTotalsByAnalysis(analyses.map((a) => a.id)).unwrapOr(new Map<string, LlmUsageTotals>());
    // ONE query for every anchor, matching the batched ledger read above — a lookup per drawn row
    // would put N queries on the open of a picker whose whole point is that it works with the
    // runtime cold. The CACHED path is used deliberately: this is a read-only display, so it must
    // not trigger the reconciliation (and its `lastSeen` write) that resolving by id performs.
    const anchorPaths = listAnchors().match(
        (as) => new Map(as.map((anchor) => [anchor.id, anchor.cachedPath])),
        () => new Map<string, string>(),
    );
    const items = analyses.map((a) => {
        const totals = usageByAnalysis.get(a.id);
        const folder = anchorPaths.get(a.anchorId);
        return {
            value: a,
            title: a.name,
            // Grouped by anchor ID, headed by its folder. Keying on the path instead would MERGE two
            // live anchors that share a stale cachedPath (delete `.inflexa/id`, re-init in place, and
            // the old row keeps that path) — mixing a dead anchor's analyses in with the current ones,
            // which is the exact ambiguity this grouping exists to remove.
            category: a.anchorId,
            categoryLabel: folder === undefined ? "(folder unknown)" : contractHome(folder),
            // An analysis with nothing recorded carries NO figure rather than a zeroed one: absent means
            // not-reported everywhere the ledger is read, and `formatTokenFigure` returns the empty
            // string for exactly that state.
            hint: [absTimeShort(new Date(a.createdAt).toISOString()), totals ? formatTokenFigure(totals) || undefined : undefined]
                .filter(Boolean)
                .join(` ${GLYPHS.middot} `),
            // The one place a row's unambiguous handle lives: the name repeats across anchors and the
            // slug repeats within them, so neither identifies a row on its own.
            description: `${a.id} ${GLYPHS.middot} ${a.slug} ${GLYPHS.middot} created ${absTime(new Date(a.createdAt).toISOString())}`,
        };
    });
    // Mirrored from the list so the copy binding below can act on the highlighted row: the list owns
    // the cursor, and `onCursorChange` is the sanctioned way for a host to read it.
    const [cursor, setCursor] = createSignal<Analysis | undefined>(items[0]?.value);
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
            onSelect={(a: Analysis) => {
                ws.closeDialog();
                void openAnalysis(ws, a);
            }}
        />
    );
}

/**
 * A thread's picker label — its pg-owned title, which is seeded from the first user message and so is
 * absent on a row that predates one. Shared by the picker and the delete confirmation so both name the
 * same conversation the same way.
 */
function threadLabel(thread: Thread): string {
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
type ThreadRead = { kind: "row"; thread: Thread } | { kind: "none" } | { kind: "unreadable" };

async function readOpenThread(pool: Pool, threadId: string, seams: SessionSeams): Promise<ThreadRead> {
    return (await seams.getThread(pool, threadId)).match(
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
export function newSessionFlow(ctx: Workspace, seams: SessionSeams = realSessionSeams): void {
    const analysis = ctx.analysis;
    if (!analysis) return;
    const phase = bootState().phase;
    if (phase !== "ready") {
        // `failed` is terminal, so "still booting" would promise a wait that never ends and contradict
        // the status bar the user is looking at. Every other non-ready phase IS a wait.
        seams.notify(
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
 * from every {@link Thread} the store returns, so the select handler branches "start fresh" from "reopen
 * this thread" without a marker field on either.
 */
const NEW_SESSION = Symbol("new-session");

/** A Switch-session pick: an existing thread to reopen, or the pinned creation row. */
type SwitchSessionChoice = Thread | typeof NEW_SESSION;

/**
 * The Switch-session picker's rows: the analysis's live threads (most-recently-active first), followed
 * by a pinned "Start a new session" row. The creation row comes LAST so the default selection stays the
 * most-recent thread — this picker is for switching, and the create action is the escape hatch out of
 * the list, not its headline. Being pinned, the row survives any filter query and an empty thread set,
 * so the picker is never empty and the create action is always one keystroke away; last-placement also
 * keeps it put, since a query matching no thread re-appends dropped pinned rows at the end.
 */
export function switchSessionItems(threads: Thread[]): SelectItem<SwitchSessionChoice>[] {
    return [
        // Durable-record rule: a listed conversation is a referenced record, so its last-activity stamp
        // is an absolute local time rather than a compact age.
        ...threads.map((t) => ({ value: t, title: threadLabel(t), description: t.updatedAt.toLocaleString() })),
        { value: NEW_SESSION, title: "Start a new session", pinned: true },
    ];
}

/**
 * Dispatch a Switch-session pick. The pinned sentinel runs the shared new-session mint-and-swap — the
 * one {@link newSessionFlow} the palette command also runs, never a second copy of the mint — while any
 * other row reopens that thread under the analysis captured when the picker opened. The dialog closes
 * first either way.
 */
export function selectSwitchSession(ctx: Workspace, choice: SwitchSessionChoice, analysis: Analysis, seams: SessionSeams): void {
    ctx.closeDialog();
    if (choice === NEW_SESSION) {
        newSessionFlow(ctx, seams);
        return;
    }
    ctx.openSession(choice.threadId, ctx.workingDir, analysis);
}

/**
 * Open the session picker over the analysis's live threads (most-recently-active first). Fetched
 * BEFORE the dialog opens — the thread store is an async Postgres read, so the dialog cannot pull it
 * from its own body — mirroring `openRunsPicker`. A read failure degrades to an empty picker rather
 * than a crash.
 *
 * The pre-ready refusal speaks rather than no-ops: the palette hides this command until `ready`, but
 * its leader chord dispatches by id and bypasses that predicate, so this path IS reachable while the
 * runtime is still booting (the same shape as `analysis.reprofile`).
 */
export async function openSwitchSession(ctx: Workspace, seams: SessionSeams = realSessionSeams): Promise<void> {
    const runtime = seams.runtime();
    const analysis = ctx.analysis;
    if (!analysis) return;
    const phase = bootState().phase;
    if (phase !== "ready" || !runtime) {
        // `failed` is terminal, so "still booting" would promise a wait that never ends and contradict
        // the status bar the user is looking at. Every other non-ready phase IS a wait.
        seams.notify(
            phase === "failed"
                ? { kind: "warn", text: "The harness did not start — conversations are unavailable." }
                : { kind: "info", text: `Harness is still booting${GLYPHS.ellipsis}` },
        );
        return;
    }
    const threads = (await seams.listThreads(runtime.pool, analysis.id)).match(
        (page) => page.threads,
        (): Thread[] => {
            seams.notify({ kind: "warn", text: "Could not list this analysis's conversations." });
            return [];
        },
    );
    // The listing is a Postgres round trip and NOTHING is modal across it — the picker has not opened
    // yet, so the analysis-switch keys are still live. Opening the picker anyway would list the
    // previous analysis's conversations, and selecting one would bind that thread beside the working
    // directory of the analysis now open: a scope naming two different analyses at once. Once the
    // picker IS open it holds the modal mode, which is what freezes the scope for as long as it lives.
    if (ctx.analysis?.id !== analysis.id) {
        seams.notify({ kind: "info", text: "Analysis changed — reopen the session picker for this one." });
        return;
    }
    ctx.openDialog(() => (
        <SelectDialog
            title="Switch session"
            placeholder={`Search sessions${GLYPHS.ellipsis}`}
            items={switchSessionItems(threads)}
            // The pinned "Start a new session" row keeps this list non-empty in every real case, so this
            // text is the contract for an items-empty render rather than a line a user reaches: a fresh
            // chat with no other threads still sees that row, not this.
            emptyText="No other conversations — send a message to start one, or switch analysis first"
            onCancel={() => ctx.closeDialog()}
            onSelect={(choice: SwitchSessionChoice) => selectSwitchSession(ctx, choice, analysis, seams)}
        />
    ));
}

function AnalysesListDialog(): JSX.Element {
    const ws = useWorkspace();
    const lines = listRecentAnalyses().match(
        (as) => as.map((a) => `${a.name}  —  ${a.slug}`),
        (e) => [`Failed to list analyses: ${e.type}`],
    );
    return <ResultsDialog title="Analyses" lines={lines} emptyText="No analyses yet" onClose={() => ws.closeDialog()} />;
}

/**
 * Reach-back picker over the session's openable artifacts (charts, figures, files, report previews),
 * newest-first. Each row shows the entry name + its resolved path; selecting one opens it externally
 * through the shared opener. Complements the `o` binding (which opens the single most-recent card).
 */
function BrowseArtifactsDialog(): JSX.Element {
    const ws = useWorkspace();
    const openables = sessionOpenables();
    const items = openables.map((openable) => ({
        value: openable,
        title: openable.entry.name,
        description: resolveEntryPath(openable.analysisId, openable.entry.target) ?? openable.entry.caption,
    }));
    return (
        <SelectDialog
            title="Browse artifacts"
            placeholder={`Search artifacts${GLYPHS.ellipsis}`}
            items={items}
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
        const current = models.current[agent] || GLYPHS.emDash;
        const pending = models.pending.get(agent);
        return pending ? `${label}: ${current} ${GLYPHS.arrowRight} ${pending} (pending)` : `${label}: ${current}`;
    };
    return [
        `connection: ${boot.connection.provider} ${GLYPHS.middot} ${boot.connection.mode} (${gloss})`,
        agentLine("chat model", "conversation"),
        agentLine("sandbox model", "sandbox"),
        agentLine("utility model", "utility"),
    ];
}

function StatusDialog(): JSX.Element {
    const ws = useWorkspace();
    const contextLine = resolveContext(ws.workingDir, {}).match(
        (c) => describeContext(c),
        (e) => `Failed to resolve context: ${e.type}`,
    );
    return <ResultsDialog title="Status" lines={[contextLine, "", ...modelStatusLines()]} emptyText="No context" onClose={() => ws.closeDialog()} />;
}

function SettingsDialog(): JSX.Element {
    const ws = useWorkspace();
    return <ConfigApp onClose={() => ws.closeDialog()} />;
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
                    description: `Move the workspace to ${archivedOutputSubdir(props.analysis.slug)}/, keeping its inputs, run artifacts, reports, and a signed provenance export — the conversations and run history are removed either way`,
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

/**
 * Injectable edges for the delete ladder, so its ORDER is assertable offline — no Postgres, no
 * SQLite, no filesystem. Order is the whole contract here (see {@link deleteAnalysisWith}), and a
 * test that only proves each stage ran would pass with the stages reordered. Production callers omit
 * the argument.
 */
export type AnalysisDeleteSeams = {
    /** The booted runtime handle, or `null`. Its pool is the only route to the purge. Real: {@link harnessRuntime}. */
    readonly runtime: () => HarnessRuntime | null;
    /**
     * Whether the analysis has a workspace tree on disk right now — the same question the disposal
     * answers with `absent`. Real: {@link locateExistingOutputDir}, whose unlocatable-folder error maps
     * to `false` because a tree inside a folder that cannot be found is one the disposal also skips.
     */
    readonly hasWorkspaceOnDisk: (a: Analysis) => boolean;
    /**
     * Drain the recorder's in-memory provenance appends into the persisted column, resolving `false`
     * when the flush could not be run at all. Real: `flushProvenanceAsync`.
     */
    readonly flushProvenance: () => Promise<boolean>;
    /**
     * Write the signed provenance document into the analysis's live workspace, resolving `false` when
     * nothing landed. Real: {@link exportProvenanceToFile}.
     */
    readonly exportProvenance: (a: Analysis) => Promise<boolean>;
    /** Archive or remove the workspace tree. Real: {@link disposeWorkspace}. */
    readonly disposeWorkspace: typeof disposeWorkspace;
    /** Reclaim the analysis's Postgres footprint. Real: `createAnalysisPurge` over the booted pool. */
    readonly purgeAnalysis: (pool: Pool, analysisId: string) => ResultAsync<AnalysisPurgeOutcome, DbError>;
    /** Delete the SQLite row; its input refs cascade. Real: {@link deleteAnalysis}. */
    readonly deleteAnalysis: typeof deleteAnalysis;
    /** What is left to land on once the row is gone. Real: {@link listRecentAnalyses}. */
    readonly listRecentAnalyses: typeof listRecentAnalyses;
    /** Land the chat on a surviving analysis. Real: {@link openAnalysis}. */
    readonly openAnalysis: (ws: Workspace, a: Analysis) => Promise<void>;
    /** Raise a transient toast. Real: {@link notify}. Injected so every refusal is observable. */
    readonly notify: (notice: Notice) => void;
};

const realAnalysisDeleteSeams: AnalysisDeleteSeams = {
    runtime: harnessRuntime,
    hasWorkspaceOnDisk: (a) =>
        locateExistingOutputDir(a).match(
            (dir) => dir !== null,
            () => false,
        ),
    // Loaded lazily for the same reason the export's PROV modules are: the recorder pulls
    // `@inflexa-ai/tsprov` in behind it. A flush that cannot run (or cannot load) costs the archive
    // this session's most recent appends and nothing more, so it resolves `false` for the outcome
    // notice rather than rejecting into the ladder above.
    flushProvenance: () =>
        ResultAsync.fromPromise(
            import("../modules/prov/prov.ts").then((m) => m.flushProvenanceAsync()),
            (cause) => cause,
        ).match(
            () => true,
            () => false,
        ),
    exportProvenance: (a) => exportProvenanceToFile(a, "json"),
    disposeWorkspace,
    // Resolved through the per-pool memo rather than built here: the booted pool outlives every
    // deletion made against it, so an adapter per deletion would leave handlers on it that nothing
    // can take back off (see {@link analysisPurgeFor}).
    purgeAnalysis: (pool, analysisId) => analysisPurgeFor(pool).purgeAnalysis(analysisId),
    deleteAnalysis,
    listRecentAnalyses,
    openAnalysis,
    notify,
};

/**
 * The purge failure, named down to the stage that raised it. A toast is the only channel this flow
 * has — no second line, and nowhere to print the driver `cause` — so whatever the notice carries is
 * the whole account the user gets. The type only classes the failure, and the purge's dozen-odd
 * statements share a handful of types between them, so `op` is what separates a refused analysis id
 * from a ledger delete that lost its connection halfway through.
 */
function describePurgeFailure(e: DbError): string {
    return `${e.type} at ${e.op}`;
}

/**
 * Delete an analysis: export its provenance, retire its workspace, reclaim its Postgres footprint,
 * and only then delete the row. Every stage sits where a failure of it leaves the deletion
 * *retryable* instead of half-done, and the order is what makes that true:
 *
 * - The SQLite row dies LAST because it holds the only copy of the analysis id, and the purge needs
 *   that id. A row deleted first strands the entire Postgres footprint beyond the reach of any
 *   retry, and does it while reporting success — the exact silent orphan this ladder exists to end.
 * - The purge follows the disposal because the filesystem move is the stage that realistically fails
 *   (permissions, an open handle), so attempting it first means such a failure touches no store at
 *   all. It runs on BOTH disposal modes: the mode governs the workspace tree, while Postgres holds
 *   the same class of state the row does — ledgers, transcripts, indexes — which goes either way.
 * - The provenance export precedes the disposal because it writes into the LIVE output directory.
 *   After a disposal that path is gone, so exporting afterwards would `mkdir` `analyses/<slug>/` back
 *   into existence holding a single file, resurrecting the directory the disposal exists to clear.
 *   For the same reason it runs only when that directory already exists: no tree means the disposal
 *   reports `absent`, and an export would have had to create the very thing being retired.
 * - Its flush precedes the export because the serializer reads the persisted column, not the
 *   recorder's memory, and deleting an analysis right after working in it is exactly when the tail
 *   of the session is still unwritten.
 *
 * A failed flush or export is stepped over — the user asked to delete the analysis, not to export
 * provenance, so a courtesy must not veto the request — but it rides the deletion's OWN outcome
 * notice rather than a toast of its own, because the toast channel replaces what is showing with the
 * next arrival and the outcome notice lands milliseconds later. A failed disposal or purge aborts
 * with the row intact and says nothing was lost, because nothing was: a re-run archives an
 * already-moved tree as `absent` and the purge is idempotent by contract.
 */
export async function deleteAnalysisWith(
    ctx: Workspace,
    a: Analysis,
    disposal: "archive" | "delete",
    seams: AnalysisDeleteSeams = realAnalysisDeleteSeams,
): Promise<void> {
    const runtime = seams.runtime();
    // Without a pool there is no purge, and a deletion that skips it recreates the orphan silently.
    // The palette refuses earlier for the user's sake; this refusal is what makes it an invariant.
    if (!runtime) {
        seams.notify({ kind: "warn", text: DELETE_NEEDS_HARNESS });
        return;
    }

    // What the archive will and will not hold, phrased to finish the outcome notice below. The export
    // reports its own failures too, but those toasts do not survive the outcome notice, so the fact
    // has to travel with it.
    //
    // Skipped entirely when there is no tree: the export's `mkdir` CREATES the output directory, so on
    // an analysis that was never opened it would conjure `analyses/<slug>/` holding a single file and
    // the disposal would archive a directory this deletion is supposed to find absent. A delete must
    // not create anything — nothing kept means nothing to write beside it. The guard belongs here and
    // not inside the export: the palette's own export command is a deliberate request for the file and
    // must keep creating the directory on demand.
    let provenanceNote = "";
    if (disposal === "archive" && seams.hasWorkspaceOnDisk(a)) {
        const flushed = await seams.flushProvenance();
        const exported = await seams.exportProvenance(a);
        provenanceNote = !exported
            ? ", but its provenance could not be exported"
            : !flushed
              ? ", though its provenance export may be missing this session's last activity"
              : "";
    }

    const disposed = seams.disposeWorkspace(a, disposal);
    if (disposed.isErr()) {
        const e = disposed.error;
        seams.notify({
            kind: "error",
            text:
                e.type === "workspace_unavailable"
                    ? e.message
                    : `Could not retire the workspace folder (${e.type}) — the analysis was NOT deleted, so nothing was lost.`,
        });
        return;
    }
    const outcome = disposed.value;

    const purged = await seams.purgeAnalysis(runtime.pool, a.id);
    if (purged.isErr()) {
        // The disposal already ran, so this is the LAST moment the archive path is known: a retry finds
        // no tree at the live location and reports `absent`, whose notice truthfully says the analysis
        // had no files on disk — leaving a user who never saw this message with no idea the artifacts
        // were moved, or where. Naming it here costs a clause and closes that gap.
        const kept = outcome.kind === "archived" ? ` Its files are already at ${outcome.path}.` : "";
        seams.notify({
            kind: "error",
            text: `Could not reclaim this analysis's stored conversations and run history (${describePurgeFailure(purged.error)}) — the analysis was NOT deleted, so nothing was lost.${kept} Try the delete again.`,
        });
        return;
    }

    const fate = outcome.kind === "archived" ? `files kept at ${outcome.path}` : outcome.kind === "deleted" ? "files deleted" : "it had no files on disk";
    seams.deleteAnalysis(a.id).match(
        (changed) => {
            if (changed === 0) {
                seams.notify({ kind: "warn", text: "Analysis not found." });
                return;
            }
            seams.notify({ kind: provenanceNote ? "warn" : "info", text: `Deleted analysis "${a.name}" — ${fate}${provenanceNote}` });
            const remaining = seams.listRecentAnalyses().match(
                (as) => as,
                () => [],
            );
            if (remaining.length > 0) {
                void seams.openAnalysis(ctx, remaining[0]!);
            } else {
                void ctx.quit();
            }
        },
        (e) => seams.notify({ kind: "error", text: `Workspace and stored data were retired, but the analysis row could not be deleted (${e.type}).` }),
    );
}

function WhoamiDialog(): JSX.Element {
    const ws = useWorkspace();
    const lines: string[] = [];
    loadAuth().match(
        (auth) => {
            const claims = decodeIdTokenClaims(auth.idToken);
            if (claims?.name) lines.push(`Name:    ${claims.name}`);
            if (claims?.email) lines.push(`Email:   ${claims.email}`);
            if (claims?.sub) lines.push(`Subject: ${claims.sub}`);
            const expiresAt = new Date(auth.expiresAt);
            const status = expiresAt.getTime() > Date.now() ? `active — expires ${expiresAt.toLocaleString()}` : "expired — renews on next use";
            lines.push(`Session: ${status}`);
        },
        (error) => lines.push(describeAuthError(error)),
    );
    return <ResultsDialog title="Identity" lines={lines} emptyText="Not logged in" onClose={() => ws.closeDialog()} />;
}

function ProjectListDialog(): JSX.Element {
    const ws = useWorkspace();
    const lines = listProjects().match(
        (projects) =>
            projects.map((p) => {
                const count = countAnalysesByProject(p.id).match(
                    (n) => n,
                    () => 0,
                );
                const tags = p.tags.length ? ` [${p.tags.join(", ")}]` : "";
                return `${p.name}${tags}  (${count} analyses)`;
            }),
        (e) => [`Failed: ${e.type}`],
    );
    return <ResultsDialog title="Projects" lines={lines} emptyText="No projects yet" onClose={() => ws.closeDialog()} />;
}

function SetProjectDialog(): JSX.Element {
    const ws = useWorkspace();
    const a = ws.analysis;
    const projects = listProjects().match(
        (ps) => ps,
        () => [],
    );
    const items = [
        { value: null as string | null, title: "(none)", description: "Clear project grouping" },
        ...projects.map((p: Project) => ({ value: p.id as string | null, title: p.name, description: p.description ?? undefined })),
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
                updateAnalysisProject(a.id, projectId).match(
                    () => {
                        const name = projectId ? (projects.find((p) => p.id === projectId)?.name ?? "unknown") : "none";
                        notify({ kind: "info", text: `Project: ${name}` });
                    },
                    (e) => notify({ kind: "error", text: `Failed: ${e.type}` }),
                );
            }}
        />
    );
}

function AddInputDialog(): JSX.Element {
    const ws = useWorkspace();
    const a = ws.analysis;
    // Existing inputs resolved to the picker's value space (canonical absolute paths). An input
    // whose anchor can't be located resolves to null and stays OUT of the seed — it can't render
    // as a row, and the confirm diff below deliberately never removes what it never showed.
    const existing = a
        ? listAnalysisInputs(a.id).match(
              (xs) => xs,
              () => [],
          )
        : [];
    const resolved: { input: AnalysisInput; abs: string }[] = [];
    for (const input of existing) {
        const abs = resolveInputPath(input).match(
            (p) => p,
            () => null,
        );
        if (abs !== null) resolved.push({ input, abs: canonicalPath(abs) });
    }
    const seed = new Set(resolved.map((r) => r.abs));
    return (
        <FilePicker
            rootPath={ws.workingDir}
            selectedPaths={seed}
            confirmLabel="Apply"
            onConfirm={(paths) => {
                ws.closeDialog();
                if (!a) return;
                // Apply the picker's final set as a diff against what was seeded: paths the user
                // added, and previously-recorded inputs whose row came back unchecked. Clearing
                // everything is a legitimate outcome here (unlike new-analysis).
                const confirmed = new Set(paths);
                const toAdd = paths.filter((p) => !seed.has(p));
                const toRemove = resolved.filter((r) => !confirmed.has(r.abs)).map((r) => r.input);
                const firstFailure = applyInputsDiff(a.id, toAdd, toRemove, ws.workingDir)[0];
                if (firstFailure) notify({ kind: "error", text: `Input update failed (${firstFailure.op}: ${firstFailure.error.type})` });
                else if (toAdd.length === 0 && toRemove.length === 0) notify({ kind: "info", text: "Inputs unchanged" });
                else notify({ kind: "info", text: `Inputs updated: +${toAdd.length} -${toRemove.length}` });
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
function inputMetaLine(input: AnalysisInput, abs: string | null): string {
    const kind = input.isDir ? "directory" : "file";
    if (abs === null) return `${kind} ${GLYPHS.middot} location unknown`;
    return statResult(abs, "removeInputs:stat").match(
        (s) =>
            [kind, input.isDir ? undefined : s.size.formatBytes(), absTimeShort(new Date(s.mtimeMs).toISOString())].filter(Boolean).join(` ${GLYPHS.middot} `),
        () => `${kind} ${GLYPHS.middot} not on disk`,
    );
}

/**
 * The absolute path of each input, with ONE anchor resolution for each distinct anchor and no
 * heartbeat write.
 *
 * `resolveInputPath` is the per-input form, and it is wrong for a listing twice over. It resolves
 * the same anchor again for every row that shares it. Its resolve also defaults to `touch: true`,
 * so opening a dialog to LOOK at the rows would record a sighting of the folder and pay a
 * synchronous SQLite write for each row. A sighting belongs to a deliberate act (launch, `open`) —
 * the same reasoning that keeps `detectSourceAnalysis` off `resolveAnchor`, and that makes the
 * analysis switcher above read the cached path.
 *
 * `null` is the unlocatable anchor, which the caller renders rather than treats as an error.
 */
function inputAbsolutePaths(inputs: readonly AnalysisInput[]): Map<AnalysisInput, string | null> {
    const byAnchor = new Map<string, string | null>();
    const out = new Map<AnalysisInput, string | null>();
    for (const input of inputs) {
        // A null anchor means the stored path is already absolute — there is nothing to resolve.
        if (input.anchorId === null) {
            out.set(input, input.path);
            continue;
        }
        const anchorId = input.anchorId;
        if (!byAnchor.has(anchorId)) {
            byAnchor.set(
                anchorId,
                resolveAnchor(anchorId, { touch: false }).match(
                    (resolved) => resolved?.path ?? null,
                    () => null,
                ),
            );
        }
        const dir = byAnchor.get(anchorId) ?? null;
        out.set(input, dir === null ? null : join(dir, input.path));
    }
    return out;
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
function RemoveInputsDialog(): JSX.Element {
    const ws = useWorkspace();
    const a = ws.analysis;
    const inputs = a
        ? listAnalysisInputs(a.id).match(
              (xs) => xs,
              () => [],
          )
        : [];
    const absolute = inputAbsolutePaths(inputs);
    const items = inputs.map((input: AnalysisInput) => {
        const abs = absolute.get(input) ?? null;
        const shown = abs ?? input.path;
        return {
            value: input,
            // The trailing separator is the type marker the picker rows already use.
            title: input.isDir ? `${shown}${sep}` : shown,
            meta: inputMetaLine(input, abs),
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
            onConfirm={(chosen: AnalysisInput[]) => {
                ws.closeDialog();
                if (!a || chosen.length === 0) return;
                // Each removal is independent, so one failure must not strand the rest — collect and
                // report rather than short-circuit (the same reasoning as `applyInputsDiff`'s removals).
                const failed: string[] = [];
                for (const input of chosen) {
                    removeInput(input).match(
                        () => {},
                        (e) => failed.push(`${input.path} (${e.type})`),
                    );
                }
                const removed = chosen.length - failed.length;
                if (failed.length > 0) notify({ kind: "error", text: `Removed ${removed} of ${chosen.length} — failed: ${failed.join(", ")}` });
                else notify({ kind: "info", text: `Removed ${removed} input${removed === 1 ? "" : "s"}` });
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
                        // The slug keys the on-disk workspace, so the rename also moves
                        // `.inflexa/analyses/<old>/` → `<new>/` (one deliberate action).
                        renameAnalysisAndMoveWorkspace(a, name).match(
                            (outcome) => {
                                notify({ kind: "info", text: `Renamed to "${raw.trim()}"` });
                                // The row is authoritative, so the rename stands either way — but a tree
                                // stranded at the old slug is invisible to every later `open`/read, and
                                // the user is the only one who can reconcile it.
                                if (outcome.moveError !== undefined) {
                                    notify({
                                        kind: "warn",
                                        text: `Workspace directory could not be moved to the new name — it remains at ${defaultOutputSubdir(a.slug)}/`,
                                    });
                                }
                                // Re-fetch the updated analysis so the workspace store (sidebar, status bar) reflects the new name.
                                matchAnalysis(a.id).match(
                                    (m) => {
                                        if (m) ws.openSession(ws.sessionId, ws.workingDir, m.analysis);
                                    },
                                    () => {},
                                );
                            },
                            (e) => notify({ kind: "error", text: `Failed: ${e.type}` }),
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
export async function openRenameSession(ctx: Workspace, seams: SessionSeams = realSessionSeams): Promise<void> {
    const runtime = seams.runtime();
    const threadId = ctx.sessionId;
    // Reachable only through the palette, whose `enabled` already requires both — this restates the
    // gate for the narrowing rather than handling a state the user can actually reach.
    if (!runtime || threadId === null) return;
    const pool = runtime.pool;
    const read = await readOpenThread(pool, threadId, seams);
    if (read.kind === "unreadable") {
        seams.notify({ kind: "error", text: "Could not read this conversation — its title was not changed." });
        return;
    }
    if (read.kind === "none") {
        seams.notify({ kind: "warn", text: "Send a message first — this conversation has no saved title yet." });
        return;
    }
    // Same window as {@link openSwitchSession}: the row read precedes the prompt, so the session-switch
    // keys are live across it. "Rename session" means the one the user is looking at — opening a prompt
    // pre-filled from the conversation they just left would retitle it under a heading claiming to be
    // about the current one.
    if (ctx.sessionId !== threadId) {
        seams.notify({ kind: "info", text: "Session changed — reopen rename for this one." });
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
                void commitSessionRename(ctx, pool, threadId, raw, seams);
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
export async function commitSessionRename(ctx: Workspace, pool: Pool, threadId: string, raw: string, seams: SessionSeams = realSessionSeams): Promise<void> {
    const title = raw.trim();
    if (!title) {
        seams.notify({ kind: "warn", text: "A title is required." });
        return;
    }
    await seams.updateTitle(pool, threadId, title).match(
        (thread) => {
            if (thread === null) {
                seams.notify({ kind: "warn", text: "This conversation is no longer saved — its title was not changed." });
                return;
            }
            seams.notify({ kind: "info", text: `Session renamed to "${title}"` });
            // The write changes the row without changing the bound id, so no reactive edge would
            // re-read it — poke the snapshot so the sidebar shows the new title.
            //
            // Only while that id is still the bound one. A session switch during the write (the
            // prompt closes on submit, so the palette is reachable again immediately) leaves this
            // poke aimed at a thread the rail no longer describes, and `refreshOpenThread` would
            // dutifully load it — painting the renamed conversation's title over the open one until
            // some later edge happened to correct it. The rename itself still landed, so the notice
            // above stands either way.
            if (ctx.sessionId === threadId) seams.refreshThread(threadId);
        },
        (e) => seams.notify({ kind: "error", text: `Failed: ${e.type}` }),
    );
}

/**
 * Remove the open session: confirm by name, tombstone the thread, then land the user on whatever this
 * analysis has left (its next most-recent thread, else a freshly minted empty chat) so the chat is
 * never left bound to a conversation that no longer lists.
 *
 * `archiveThread` sets `deleted_at`, so the row and every message survive and the thread merely stops
 * appearing anywhere — {@link openRestoreSession} is the way back. Every word the user reads therefore
 * says REMOVE, not delete — the confirm ritual (danger chrome, type the name back) is the app's
 * strongest irreversibility signal, and spending it on an action that keeps the transcript, and that
 * the user can undo from the palette, would teach them to distrust it where it is telling the truth.
 */
export async function deleteSessionFlow(ctx: Workspace, seams: SessionSeams = realSessionSeams): Promise<void> {
    const runtime = seams.runtime();
    const analysis = ctx.analysis;
    const threadId = ctx.sessionId;
    // An absent analysis or an unbound thread names no conversation the user could have meant, so the
    // narrowing is silent; the palette's `enabled` requires both anyway.
    if (!analysis || threadId === null) return;
    // The unbooted harness is the one reachable miss, because the leader chord dispatches by command
    // id and never consults `enabled` — so it speaks rather than swallowing the keystroke, exactly as
    // {@link openRestoreSession} does for the same bypass.
    if (!runtime) {
        seams.notify({ kind: "warn", text: SESSION_NEEDS_HARNESS });
        return;
    }
    const pool = runtime.pool;
    // Both refusals below share one cause — no name to confirm against, and asking the user to type a
    // fiction is not a confirmation — but they are not the same fact, so they do not get the same words.
    const read = await readOpenThread(pool, threadId, seams);
    if (read.kind === "unreadable") {
        seams.notify({ kind: "error", text: "Could not read this conversation — nothing was removed." });
        return;
    }
    if (read.kind === "none") {
        seams.notify({ kind: "info", text: "This conversation has nothing saved yet — there is nothing to remove." });
        return;
    }
    // Same window as {@link openSwitchSession}, and the costliest of the three to get wrong: the
    // confirmation would name the conversation the user just left, and confirming it both tombstones
    // that one and re-lands the chat — yanking the user off the session they had switched to, for a
    // removal they did not ask for there.
    if (ctx.sessionId !== threadId) {
        seams.notify({ kind: "info", text: "Session changed — reopen remove for this one." });
        return;
    }
    const name = threadLabel(read.thread);
    ctx.openDialog(() => (
        <ConfirmDeleteDialog
            entityLabel="session"
            entityName={name}
            verb="Remove"
            description={() => <text fg={theme().fgMuted}>It stops appearing in this analysis. The transcript is kept — nothing is erased.</text>}
            onConfirm={() => void confirmSessionDelete(ctx, pool, analysis, threadId, seams)}
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
export async function confirmSessionDelete(
    ctx: Workspace,
    pool: Pool,
    analysis: Analysis,
    threadId: string,
    seams: SessionSeams = realSessionSeams,
): Promise<void> {
    await seams.archiveThread(pool, threadId).match(
        async () => {
            seams.notify({ kind: "info", text: "Session removed — it no longer appears in this analysis." });
            // Unbind BEFORE the landing, which is another Postgres round trip. Across that window the
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
            await openAnalysis(ctx, analysis, seams);
        },
        // The thread is still bound and still lists, so nothing is re-landed — leaving the user
        // exactly where they were is the truthful outcome of a removal that did not happen.
        async (e) => seams.notify({ kind: "error", text: `Failed: ${e.type}` }),
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
export async function purgeSessionFlow(ctx: Workspace, seams: SessionSeams = realSessionSeams): Promise<void> {
    const runtime = seams.runtime();
    const analysis = ctx.analysis;
    const threadId = ctx.sessionId;
    // The same two gates the removal flow raises, in the same order and for the same reasons: silence
    // where no conversation is named, a spoken refusal where the chord bypassed `enabled`.
    if (!analysis || threadId === null) return;
    if (!runtime) {
        seams.notify({ kind: "warn", text: SESSION_NEEDS_HARNESS });
        return;
    }
    // A turn streaming into this very thread is the one state that makes the purge destructive beyond
    // what the user asked for. `appendTurn` writes its messages with no foreign key and tolerates a
    // missing thread row, so a turn committing after the purge lands rows under a `thread_id` that
    // resolves to no analysis — reachable by nothing, since the only route from an analysis to its
    // messages is a join through the thread row this deleted. The harness states the precondition and
    // cannot enforce it, because it cannot see a host's in-flight turns; this is where it is met.
    //
    // The narrower check rather than the analysis-wide busy gate: a running data profile or workflow
    // writes nothing into `messages`, so refusing a conversation delete for one would block the user
    // over state that cannot be harmed. `chatStatus` is already thread-scoped here, because this flow
    // only ever purges the OPEN thread. Checked once, before the dialog opens — the modal blocks the
    // composer, so no turn can start between the check and the confirmation.
    //
    // Removal deliberately has no such gate: a turn landing after an archive leaves its messages on a
    // tombstoned row that Restore brings back intact, which is a recoverable outcome, not a loss.
    if (seams.chatBusy()) {
        seams.notify({ kind: "warn", text: "Cannot delete this conversation while a chat turn is running — wait for it to finish, or stop it first." });
        return;
    }
    const pool = runtime.pool;
    // Absence and unreadability are different facts about the user's data, so they get different words
    // — the same split the removal flow makes, and for the same reason.
    const read = await readOpenThread(pool, threadId, seams);
    if (read.kind === "unreadable") {
        seams.notify({ kind: "error", text: "Could not read this conversation — nothing was deleted." });
        return;
    }
    if (read.kind === "none") {
        seams.notify({ kind: "info", text: "This conversation has nothing saved yet — there is nothing to delete." });
        return;
    }
    // The costliest window in the app to get wrong: the confirmation would name the conversation the
    // user just left, and typing that name would erase it — irrecoverably, for a conversation they were
    // not even looking at.
    if (ctx.sessionId !== threadId) {
        seams.notify({ kind: "info", text: "Session changed — reopen delete for this one." });
        return;
    }
    const name = threadLabel(read.thread);
    ctx.openDialog(() => (
        <ConfirmDeleteDialog
            entityLabel="session"
            entityName={name}
            // No `verb`: the default IS "Delete", and this is the action that word was reserved for.
            description={() => <text fg={theme().fgMuted}>Every message in it is erased. This cannot be undone — Restore session cannot bring it back.</text>}
            onConfirm={() => void confirmSessionPurge(ctx, pool, analysis, threadId, seams)}
        />
    ));
}

/**
 * Hard-delete the confirmed thread, then land the user on whatever the analysis has left. Lives beside
 * the confirmation rather than inside its `onConfirm` so the post-confirm ladder is testable headlessly
 * (the {@link confirmSessionDelete} shape); the dialog owns only the name match and its close.
 *
 * The landing repeats the removal flow's unbind-then-open, and the unbind matters more here: the row
 * the scope names is not merely tombstoned but gone, so a turn submitted across the landing's round
 * trip would recreate a thread under an id the user just erased.
 */
export async function confirmSessionPurge(
    ctx: Workspace,
    pool: Pool,
    analysis: Analysis,
    threadId: string,
    seams: SessionSeams = realSessionSeams,
): Promise<void> {
    await seams.purgeThread(pool, threadId).match(
        async () => {
            seams.notify({ kind: "info", text: "Session deleted — its transcript is gone." });
            // Unbind BEFORE the landing's Postgres round trip. Across that window the scope would
            // otherwise still name a thread id whose row no longer exists, and a turn submitted into it
            // passes every gate: the id is non-null, and the thread store's create would mint the row
            // back — resurrecting, as an empty conversation, the very thing the user just erased.
            ctx.openSession(null, ctx.workingDir, analysis);
            // Re-enter through the analysis-open path: it performs exactly the landing this needs —
            // bind the surviving most-recent thread, else a fresh mint.
            await openAnalysis(ctx, analysis, seams);
        },
        // The thread is still there and still lists, so nothing is re-landed — leaving the user exactly
        // where they were is the truthful outcome of a deletion that did not happen.
        async (e) => seams.notify({ kind: "error", text: `Failed: ${e.type}` }),
    );
}

/**
 * A thread whose archive tombstone is known to be set, so the picker can render the moment it left
 * view without a non-null assertion on a column that is nullable for every live row.
 */
type ArchivedThread = Thread & { readonly deletedAt: Date };

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
async function collectArchivedThreads(pool: Pool, analysisId: string, seams: SessionSeams): Promise<ArchivedListing> {
    const threads: ArchivedThread[] = [];
    for (let page = 0; page < ARCHIVED_PAGE_LIMIT; page += 1) {
        const read = await seams.listThreadsWithArchived(pool, analysisId, page);
        if (read.isErr()) return { kind: "unreadable" };
        // The predicate narrows the row type as it filters, which is what lets the picker read
        // `deletedAt` as a date rather than assert on a column nullable for every live row.
        threads.push(...read.value.threads.filter((t): t is ArchivedThread => t.deletedAt !== null));
        if (!read.value.hasMore) return { kind: "read", threads, truncated: false };
    }
    return { kind: "read", threads, truncated: true };
}

/**
 * Open the restore picker over the analysis's archived conversations. Fetched BEFORE the dialog opens
 * for the same reason the switch picker's listing is — the thread store is an async Postgres read that
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
export async function openRestoreSession(ctx: Workspace, seams: SessionSeams = realSessionSeams): Promise<void> {
    const runtime = seams.runtime();
    const analysis = ctx.analysis;
    if (!analysis) return;
    const phase = bootState().phase;
    if (phase !== "ready" || !runtime) {
        // `failed` is terminal, so "still booting" would promise a wait that never ends and contradict
        // the status bar the user is looking at. Every other non-ready phase IS a wait.
        seams.notify(
            phase === "failed"
                ? { kind: "warn", text: "The harness did not start — archived conversations are unavailable." }
                : { kind: "info", text: `Harness is still booting${GLYPHS.ellipsis}` },
        );
        return;
    }
    const pool = runtime.pool;
    const listed = await collectArchivedThreads(pool, analysis.id, seams);
    if (listed.kind === "unreadable") {
        seams.notify({ kind: "warn", text: "Could not list this analysis's archived conversations." });
        return;
    }
    const archived = listed.threads;
    // The listing is a Postgres round trip and NOTHING is modal across it, exactly as in
    // {@link openSwitchSession}: the analysis-switch keys are still live, so a picker opened anyway
    // would offer the previous analysis's archived conversations under the current analysis's heading.
    if (ctx.analysis?.id !== analysis.id) {
        seams.notify({ kind: "info", text: "Analysis changed — reopen restore for this one." });
        return;
    }
    // After the changed-analysis refusal, not before it: the toast channel shows one notice at a time,
    // so a caveat about a listing that is no longer being offered would only displace the refusal.
    if (listed.truncated) {
        seams.notify({ kind: "warn", text: "This analysis has more conversations than the picker can walk — some archived ones are not listed." });
    }
    ctx.openDialog(() => (
        <SelectDialog
            title="Restore session"
            placeholder={`Search archived sessions${GLYPHS.ellipsis}`}
            // Durable-record rule: a listed conversation is a referenced record, so its stamp is an
            // absolute local time. The tombstone rather than the activity clock, because what tells two
            // archived conversations apart is when each one was removed — the archive leaves
            // `updatedAt` on the last turn, which can predate the removal by weeks.
            items={archived.map((t) => ({ value: t, title: threadLabel(t), description: `Removed ${t.deletedAt.toLocaleString()}` }))}
            // Removal is the only thing that puts a row here, so the empty state names it rather than
            // leaving the user to guess what this picker is ever supposed to hold.
            emptyText="No archived conversations — removing one from this analysis puts it here"
            onCancel={() => ctx.closeDialog()}
            onSelect={(t: ArchivedThread) => {
                ctx.closeDialog();
                void commitSessionRestore(pool, t, seams);
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
export async function commitSessionRestore(pool: Pool, thread: Thread, seams: SessionSeams = realSessionSeams): Promise<void> {
    await seams.unarchiveThread(pool, thread.threadId).match(
        () => seams.notify({ kind: "info", text: `Session restored — "${threadLabel(thread)}" appears in this analysis again.` }),
        (e) => seams.notify({ kind: "error", text: `Failed: ${e.type}` }),
    );
}

/**
 * The three edges the provenance export reads through, injected so its ORDERING is assertable
 * without a signing key, a provenance chain, or an anchored workspace. Production callers omit them
 * and {@link loadProvExportSeams} resolves the real ones.
 */
export type ProvExportSeams = {
    /** Where the document lands — the analysis's live workspace root. Real: {@link resolveOutputDir}. */
    readonly resolveOutputDir: typeof resolveOutputDir;
    /** The persisted provenance chain, rendered in the requested format. Real: `document.serializeProvenance`. */
    readonly serializeProvenance: typeof import("../modules/prov/document.ts").serializeProvenance;
    /** The detached signature over the serialized document. Real: `verify.buildSidecar`. */
    readonly buildSidecar: typeof import("../modules/prov/verify.ts").buildSidecar;
};

/**
 * Resolve the real export edges, or `null` when the provenance stack cannot be loaded at all.
 *
 * The PROV modules are imported LAZILY — they depend on `@inflexa-ai/tsprov`, so a static import
 * would pull that into this module's graph; deferring it both keeps the palette lean and contains a
 * tsprov load failure to the one action that needs it. The `catch` exists only to turn that failure
 * into the caller's `null` branch, since a dynamic import signals unavailability by rejecting.
 */
async function loadProvExportSeams(): Promise<ProvExportSeams | null> {
    try {
        const prov = await import("../modules/prov/document.ts");
        const verify = await import("../modules/prov/verify.ts");
        return { resolveOutputDir, serializeProvenance: prov.serializeProvenance, buildSidecar: verify.buildSidecar };
    } catch {
        return null;
    }
}

/**
 * Serialize an analysis's provenance into its output folder — the document and its signature
 * sidecar — then notify the destination.
 *
 * The sidecar is built BEFORE either file is written, and a signing failure writes neither. Writing
 * the document first would leave unsigned provenance on disk beneath a notice saying provenance is
 * never exported unsigned; the delete flow exports on the user's behalf without being asked, which
 * makes that contradiction routine rather than rare. A sidecar that cannot be *written* after the
 * document already landed is reported differently, because that leaves a real file the user has.
 *
 * Exported for the delete ladder, which exports into the live workspace before retiring it, and for
 * the ordering tests. Resolves `true` only when both files landed — every failure is notified here,
 * but a caller acting on the user's behalf needs the fact as well as the toast, because the toast
 * channel replaces what is showing with the next arrival.
 */
export async function exportProvenanceToFile(a: Analysis, format: BuiltinProvFormat, injected?: ProvExportSeams): Promise<boolean> {
    const seams = injected ?? (await loadProvExportSeams());
    if (!seams) {
        notify({ kind: "error", text: "Provenance export is unavailable (the tsprov library failed to load)." });
        return false;
    }

    const dir = seams.resolveOutputDir(a).match(
        (d) => d,
        () => null,
    );
    if (!dir) {
        notify({ kind: "error", text: "Could not resolve this analysis's output directory." });
        return false;
    }

    const text = seams.serializeProvenance(a, format).match(
        (t) => t,
        (e) => {
            notify({ kind: "error", text: `Failed to build provenance: ${e.type}` });
            return null;
        },
    );
    if (!text) return false;

    // Provenance + sidecar are one logical export: the signature has to exist before anything is
    // written, so a signing failure leaves the destination exactly as it found it.
    const sidecarResult = await seams.buildSidecar(text);
    if (sidecarResult.isErr()) {
        notify({ kind: "error", text: `Signing failed (${sidecarResult.error.type}) — provenance is never exported unsigned.` });
        return false;
    }

    const dest = join(dir, `provenance.${format}`);
    const writeResult = mkdirResult(dir, "exportProvenance:mkdir").andThen(() => writeFileResult(dest, text, "exportProvenance:write"));
    if (writeResult.isErr()) {
        notify({ kind: "error", text: `Failed to write provenance: ${String(writeResult.error.cause)}` });
        return false;
    }

    const sigDest = `${dest}.sig.json`;
    const sidecarWrite = writeFileResult(sigDest, JSON.stringify(sidecarResult.value, null, 2), "exportProvenance:sidecar");
    if (sidecarWrite.isErr()) {
        notify({ kind: "error", text: `Wrote provenance but sidecar failed: ${String(sidecarWrite.error.cause)}` });
        return false;
    }

    notify({ kind: "info", text: `Wrote ${format} provenance to ${dest}` });
    return true;
}

/**
 * How many runs the picker's fresh fetch pulls. A deliberate cap, not pagination — the picker's
 * fuzzy filter narrows within it, no analysis is expected to approach it, and when a fetch comes
 * back exactly at the cap the picker's title says "newest 100" so the truncation is never silent.
 */
const RUNS_PICKER_LIMIT = 100;

/**
 * Extract a plan's human title from the persisted plan JSON. `loadPlan` returns the raw stored
 * document as `unknown` (the harness parses it against its own schema at use sites, not here), so
 * this narrows structurally and returns `null` when the title is absent or blank — historical
 * pre-title plans — letting the caller fall back to the workflow-name label rather than a crash.
 */
function planTitleOf(plan: unknown): string | null {
    if (typeof plan !== "object" || plan === null || !("title" in plan)) return null;
    // `title` is `unknown` after the `in` narrowing; the persistence schema types it optional, so
    // guard the runtime type before trusting it as a string.
    const title = plan.title;
    return typeof title === "string" && title.trim().length > 0 ? title.trim() : null;
}

/**
 * Open the searchable runs picker → run-detail flow. The SINGLE open path behind all three entry
 * points (the `runs.show` palette command, the sidebar RUNS section click, and its leader chord —
 * the app routes the latter two through the command), so every door shows the identical picker.
 *
 * Fetches fresh at open (newest-first, {@link RUNS_PICKER_LIMIT}) rather than reading the sidebar
 * store's snapshot: the rail's snapshot is capped small for the poll loop, and investigation needs
 * history. Pre-ready (or on a read failure) it degrades to the muted placeholder dialog without
 * querying — the same not-ready vocabulary the rail uses. Selecting a run STACKS the detail dialog
 * over the picker (no close-then-open, diverging from `plan.explore-steps`' one-shot lookup):
 * dismissing the detail lands back in the still-mounted picker, the right shape for inspecting
 * several runs in a row.
 */
async function openRunsPicker(ctx: Workspace): Promise<void> {
    const runtime = harnessRuntime();
    const analysis = ctx.analysis;
    const title = analysis ? `Runs ${GLYPHS.emDash} ${analysis.name}` : "Runs";
    if (bootState().phase !== "ready" || !runtime || !analysis) {
        ctx.openDialog(() => <ResultsDialog title={title} lines={["runtime not ready"]} emptyText="runtime not ready" onClose={() => ctx.closeDialog()} />);
        return;
    }
    const rows = (await queryRunsByAnalysis(runtime.pool, analysis.id, { limit: RUNS_PICKER_LIMIT })).match(
        (rs): CortexRunRow[] | null => rs,
        () => null,
    );
    if (rows === null) {
        ctx.openDialog(() => <ResultsDialog title={title} lines={["runs unavailable"]} emptyText="runs unavailable" onClose={() => ctx.closeDialog()} />);
        return;
    }
    // Resolve each run's human plan title. The run row itself only carries the workflow name
    // ("executeAnalysis" — identical on every run) plus a `planId`; the readable 3–8-word name the
    // planner set lives on the plan (cortex_plans). Fetch the DISTINCT plans (re-runs of one plan
    // share a planId, so dedup) and label rows by title, falling back to the workflow name where a
    // plan is gone or predates titles. CLI-side join by choice — the alternative is a title column
    // on cortex_runs; kept here so the picker stays the only reader that pays for it.
    const planIds = [...new Set(rows.map((r) => r.planId).filter((id): id is string => id !== null))];
    const titleByPlanId = new Map<string, string>();
    await Promise.all(
        // TODO(robustness): make a batch plan load here. An analysis has a low number of runs, it will not exceed tens of runs (most probably).
        planIds.map((planId) =>
            loadPlan(runtime.pool, planId, { analysisId: analysis.id }).match(
                (plan) => {
                    const t = planTitleOf(plan);
                    if (t) titleByPlanId.set(planId, t);
                },
                // A plan read that fails just falls back to the workflow-name label — the picker
                // must still open, and a missing title is a degraded row, not an error.
                () => {},
            ),
        ),
    );
    // Every drawn run's figures in ONE local-ledger read, keyed by run id — not a query per row, and
    // not a second read inside the detail dialog either (the picked row's totals ride in as data).
    // The read is CLI-local SQLite while everything above this line was Postgres, so a failure here is
    // independent and degrades on its own: the map is empty, rows and detail simply carry no figure.
    const usageByRun = listAnalysisUsageByRun(analysis.id).match(
        (groups) => new Map(groups.map((g) => [g.runId, g.totals])),
        () => new Map<string, LlmUsageTotals>(),
    );
    const atCap = rows.length === RUNS_PICKER_LIMIT;
    ctx.openDialog(() => (
        <SelectDialog
            title={atCap ? `${title} (newest ${RUNS_PICKER_LIMIT})` : title}
            placeholder={`Search runs${GLYPHS.ellipsis}`}
            items={rows.map((run) => {
                // Title first, id tail always appended: two runs of the SAME plan share a title, so
                // the tail is what tells them apart.
                const label = (run.planId ? titleByPlanId.get(run.planId) : undefined) ?? shortRunName(run);
                // A run with no ledger rows contributes NO segment rather than a zeroed one — the same
                // absent-means-not-reported rule the ledger keeps all the way down from its NULL sums.
                const totals = usageByRun.get(run.runId);
                const figure = totals ? formatTokenFigure(totals) : "";
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
            onSelect={(run: CortexRunRow) => {
                // Read at SELECT, not with the run totals above: this is one query per run the user
                // actually opens, where hoisting it into the batch would query every drawn row's steps
                // to serve the one row that gets picked. It is a local SQLite read on an indexed scope,
                // so it costs nothing worth deferring, and a failure degrades to an empty map — the
                // steps still list, they just carry no figures.
                const stepUsage = listRunUsageByStep(analysis.id, run.runId).match(
                    (groups): RunStepUsage => ({
                        byStep: new Map(groups.flatMap((g) => (g.stepId === null ? [] : [[g.stepId, g.totals] as const]))),
                        // The read groups by `step_id` and SQLite groups NULL with itself, so a run's
                        // step-less calls arrive as one group with a null id. It is carried across
                        // rather than filtered out with the map keys: the dialog's headline counts
                        // those calls, so dropping them here is what would make the total disagree
                        // with the steps below it.
                        unattributed: groups.find((g) => g.stepId === null)?.totals ?? null,
                    }),
                    // A failed read is not a measurement of zero — the steps still list, they just
                    // carry no figures, and `null` says no remainder is known rather than none exists.
                    (): RunStepUsage => ({ byStep: new Map(), unattributed: null }),
                );
                ctx.openDialog(() => (
                    <RunDetailDialog
                        run={run}
                        loadSteps={(runId) => queryStepsByRun(runtime.pool, runId)}
                        usage={usageByRun.get(run.runId)}
                        stepUsage={stepUsage}
                        onClose={() => ctx.closeDialog()}
                    />
                ));
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
        run: (ctx) => ctx.openDialog(() => <SwitchAnalysisDialog />),
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
        run: (ctx) => ctx.openDialog(() => <AnalysesListDialog />),
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
        run: (ctx) => ctx.openDialog(() => <AddInputDialog />),
    },
    {
        // The id stays `remove-input` though the surface now takes a batch: it is the key a user's
        // `config.keybinds` entry can already be bound to, and renaming it would silently orphan that.
        id: "analysis.remove-input",
        title: "Remove inputs",
        description: "Remove one or more inputs from this analysis",
        category: "Analysis",
        enabled: (ctx) => ctx.analysis !== null,
        run: (ctx) => ctx.openDialog(() => <RemoveInputsDialog />),
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
            // A deliberate manual action, but the force driver needs the booted runtime. When boot has
            // not reached ready, refuse with a notice (matching the status bar's "booting…") rather than
            // silently no-op'ing — the command is analysis-scoped via `enabled`, not boot-scoped, since
            // the predicate only sees the workspace.
            const runtime = harnessRuntime();
            if (bootState().phase !== "ready" || !runtime) {
                notify({ kind: "info", text: `Harness is still booting${GLYPHS.ellipsis}` });
                return;
            }
            void driveForceReprofile(runtime, a, () => ctx.analysis?.id ?? null);
        },
    },
    {
        id: "analysis.set-project",
        title: "Set project",
        description: "Attach, move, or clear this analysis's project grouping",
        category: "Analysis",
        enabled: (ctx) => ctx.analysis !== null,
        run: (ctx) => ctx.openDialog(() => <SetProjectDialog />),
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
            // Gated BEFORE the quiescence check and both dialogs: the ladder cannot purge without the
            // booted pool and will refuse anyway, so asking the user to type the analysis's name and
            // choose a disposal first would spend their confirmation on a refusal.
            if (!harnessRuntime()) {
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
        run: (ctx) => {
            const a = ctx.analysis;
            if (!a) return;
            openOutputDir(a).match(
                (d) => notify({ kind: "info", text: `Opened ${d}` }),
                // `workspace_unavailable` already carries the folder and the remedy — print it verbatim
                // rather than reducing it to a `type` the user cannot act on.
                (e) => notify({ kind: "error", text: e.type === "workspace_unavailable" ? e.message : `Failed to open: ${e.type}` }),
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

            let verify: typeof import("../modules/prov/verify.ts");
            let kernel: typeof import("@inflexa-ai/prov-kernel");
            try {
                verify = await import("../modules/prov/verify.ts");
                kernel = await import("@inflexa-ai/prov-kernel");
            } catch {
                notify({ kind: "error", text: "Provenance verification is unavailable." });
                return;
            }

            const result = await verify.verifyAnalysisIntegrity(a.id);
            if (!result) {
                notify({ kind: "error", text: "Could not read provenance data." });
                return;
            }

            notify({ kind: noticeKindFor(result), text: kernel.formatVerifyResult(result) });
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

            let verify: typeof import("../modules/prov/verify.ts");
            let kernel: typeof import("@inflexa-ai/prov-kernel");
            let output: typeof import("../modules/analysis/output.ts");
            try {
                verify = await import("../modules/prov/verify.ts");
                kernel = await import("@inflexa-ai/prov-kernel");
                output = await import("../modules/analysis/output.ts");
            } catch {
                notify({ kind: "error", text: "Provenance verification is unavailable." });
                return;
            }

            const dir = output.resolveOutputDir(a).match(
                (d) => d,
                () => null,
            );
            if (!dir) {
                notify({ kind: "error", text: "Could not resolve this analysis's output directory." });
                return;
            }

            const provPath = join(dir, "provenance.json");
            if (!existsSync(provPath)) {
                notify({ kind: "warn", text: "No exported provenance.json found. Export provenance first." });
                return;
            }

            const result = await verify.verifyExportFile(provPath);
            if (!result) {
                notify({ kind: "warn", text: "No .sig.json sidecar found. The export may be unsigned." });
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
        run: (ctx) => ctx.openDialog(() => <ProjectListDialog />),
    },
    {
        id: "project.delete",
        title: "Delete project",
        description: "Delete a project (analyses are ungrouped, not deleted)",
        category: "Project",
        run: (ctx) => {
            const projects = listProjects().match(
                (ps) => ps,
                () => [],
            );
            ctx.openDialog(() => (
                <SelectDialog
                    title="Delete project"
                    placeholder={`Select project to delete${GLYPHS.ellipsis}`}
                    items={projects.map((p: Project) => ({ value: p, title: p.name, description: p.description ?? undefined }))}
                    emptyText="No projects"
                    onCancel={() => ctx.closeDialog()}
                    onSelect={(p: Project) => {
                        ctx.closeDialog();
                        ctx.openDialog(() => (
                            <ConfirmDeleteDialog
                                entityLabel="project"
                                entityName={p.name}
                                onConfirm={() => {
                                    deleteProject(p.id).match(
                                        (changed) => {
                                            if (changed === 0) {
                                                notify({ kind: "warn", text: "Project not found." });
                                                return;
                                            }
                                            notify({ kind: "info", text: `Deleted project "${p.name}"` });
                                        },
                                        (e) => notify({ kind: "error", text: `Failed: ${e.type}` }),
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
        run: (ctx) => ctx.openDialog(() => <WhoamiDialog />),
    },
    {
        id: "view.status",
        title: "Show status",
        description: "What inflexa resolves to here, plus the model connection",
        category: "View",
        run: (ctx) => ctx.openDialog(() => <StatusDialog />),
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
        run: (ctx) => ctx.openDialog(() => <SettingsDialog />),
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
        run: (ctx) => ctx.openDialog(() => <BrowseArtifactsDialog />),
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
        // Gated on the booted runtime: the picker's fresh fetch needs the live pool. The open path
        // itself still degrades pre-ready (the sidebar entry points bypass this predicate).
        enabled: (ws) => bootState().phase === "ready" && harnessRuntime() !== null && ws.analysis !== null,
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
