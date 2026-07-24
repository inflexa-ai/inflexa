import { createSignal, Show, type JSX } from "solid-js";
import { existsSync } from "node:fs";
import { join } from "node:path";
// Type-only — erased at compile time, so it does NOT pull tsprov/verify into the TUI's startup path.
import type { BuiltinProvFormat } from "@inflexa-ai/tsprov";
import type { VerifyResult } from "../types/prov.ts";

import { PromptDialog } from "./components/dialog/prompt_dialog.tsx";
import { ResultsDialog } from "./components/dialog/results_dialog.tsx";
import { SelectDialog } from "./components/dialog/select_dialog.tsx";
import { PlanStepDetailDialog } from "./components/dialog/plan_step_detail_dialog.tsx";
import { RunDetailDialog } from "./components/dialog/run_detail_dialog.tsx";
import { FilePicker } from "./components/dialog/file_picker.tsx";
import { ConfigApp } from "./app_config.tsx";
import { DesignGallery } from "./layout/design_gallery.tsx";
import { setTheme, theme } from "./theme.ts";
import { notify } from "./hooks/notice.ts";
import { loadPlan, queryRunsByAnalysis, queryStepsByRun } from "@inflexa-ai/harness";
import type { CortexRunRow } from "@inflexa-ai/harness";

import { agentModels, bootState, harnessRuntime } from "./hooks/boot.ts";
import { latestPlanCard, sessionOpenables, type SessionOpenable } from "./hooks/conversation.ts";
import { openArtifact } from "./hooks/artifacts.ts";
import { resolveEntryPath } from "../modules/harness/artifact_open.ts";
import { driveForceReprofile, profileWorkInFlight } from "./hooks/profile_parity.ts";
import { RUN_STATUS_TERMINAL, absTime, absTimeShort, idTail, shortRunName } from "./hooks/sidebar_live.ts";
import { chatStatus } from "./hooks/status.ts";
import { keybindLabel } from "./keymap.ts";
import { useWorkspace, type Workspace } from "./contexts/workspace.ts";
import { GLYPHS, themes, themeIds, type ThemeId } from "../lib/design_system.ts";
import { readConfig, writeConfig } from "../lib/config.ts";
import { mkdirResult, writeFileResult } from "../lib/fs.ts";
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
import { listConnectionModels, validateModelSelection } from "../modules/harness/model_listing.ts";
import type { ModelAccess } from "../modules/proxy/models.ts";
import { currentAgentModels, requestAgentModelChange } from "../modules/harness/agent_switch.ts";
import { resolveInputPath } from "../modules/analysis/input.ts";
import { resolveContext, describeContext } from "../modules/analysis/context.ts";
import { openOutputDir } from "../modules/analysis/open.ts";
import { archivedOutputSubdir, defaultOutputSubdir, disposeWorkspace } from "../modules/analysis/output.ts";
import { resolveAnchor, resolvedPathOrCached } from "../modules/anchor/anchor.ts";
import { canonicalPath } from "../modules/anchor/marker.ts";
import { loadAuth, describeAuthError } from "../modules/auth/auth.ts";
import { decodeIdTokenClaims } from "../modules/auth/whoami.ts";
import { createProject, createSession, deleteAnalysis, deleteProject, deleteSession, renameSession, updateAnalysisProject } from "../db/primary_mutation.ts";
import { getSession, listSessionsByAnalysis, listProjects, listAnalysisInputs, countAnalysesByProject } from "../db/primary_query.ts";
import type { Analysis, AnalysisInput } from "../types/analysis.ts";
import type { Session } from "../types/session.ts";
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
 * profile, or a durable run that outlived the turn that launched it (`execute_plan` returns before
 * its workflow does). Checked once, before the dialog opens: a modal blocks the composer, so no
 * new work can start between the check and the action.
 */
async function workspaceBusyReason(analysisId: string): Promise<string | null> {
    if (chatStatus() === "busy") return "a chat turn is running";
    if (profileWorkInFlight()) return "a data profile is running";

    const runtime = harnessRuntime();
    // Nothing booted ⇒ no workflow in this process can hold the tree.
    if (!runtime) return null;

    return (await queryRunsByAnalysis(runtime.pool, analysisId, { limit: 20 })).match(
        (runs) => (runs.some((r) => !RUN_STATUS_TERMINAL[r.status]) ? "a run is in flight" : null),
        // Refuse rather than guess: an unreadable ledger cannot prove the workspace is idle.
        () => "the run ledger is unreadable, so the workspace cannot be confirmed idle",
    );
}

// Open an analysis's chat in place: reuse its most-recent session or create one, then swap.
function openAnalysis(ws: Workspace, a: Analysis): void {
    const sessions = listSessionsByAnalysis(a.id).match(
        (ss) => ss,
        () => [],
    );
    sessions.sort((x, y) => y.updatedAt - x.updatedAt);
    const existing = sessions[0];
    const session =
        existing ??
        createSession({ title: `Chat — ${a.name}`, analysisId: a.id }).match(
            (s) => s,
            () => null,
        );
    if (!session) {
        notify({ kind: "error", text: "Failed to open a session" });
        return;
    }
    ws.openSession(session.id, workingDirFor(a), a);
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

function ThemePicker(): JSX.Element {
    const ws = useWorkspace();
    const current = readConfig().theme;
    const items = themeIds.map((id) => ({ value: id, title: themes[id].name, hint: id === current ? "current" : undefined }));
    return (
        <SelectDialog
            title="Change theme"
            placeholder={`Search themes${GLYPHS.ellipsis}`}
            items={items}
            emptyText="No themes"
            onCancel={() => ws.closeDialog()}
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
    return agent === "conversation" ? "Chat" : "Sandbox";
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
 * The agent-parameterized model picker: a {@link SelectDialog} over the connection's live models with the
 * agent's CURRENT model marked, degrading to a {@link PromptDialog} free-text entry when listing failed
 * (`models === null`). A "manual entry" row in that listing ALSO opens the same free-text field (pre-filled
 * with the current model) even when a listing IS present — so an id the connection does not enumerate stays
 * reachable, mirroring direct-setup, which always prompts free text. A committed pick (listed OR free-text)
 * is accessibility-validated (design D6)
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
    /** The agent's currently-running model, marked `current` in the list and pre-filled in the free-text field. */
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
    const title = (): string => (props.agent === "conversation" ? "Switch chat model" : "Switch sandbox model");

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
                        value={props.current}
                        placeholder="Enter a model id"
                        description={
                            props.models
                                ? undefined
                                : () => <text fg={theme().fgMuted}>Could not list the connection's models — enter a model id manually.</text>
                        }
                        onCancel={props.onCancel}
                        onSubmit={commit}
                    />
                }
            >
                {(models: readonly string[]) => (
                    <SelectDialog
                        title={title()}
                        placeholder={`Search models${GLYPHS.ellipsis}`}
                        items={[
                            ...models.map((id) => ({ value: id, title: id, hint: id === props.current ? "current" : undefined })),
                            { value: MANUAL_MODEL_SENTINEL, title: `Enter a model id manually${GLYPHS.ellipsis}` },
                        ]}
                        emptyText="No models listed by the connection"
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
                        openAnalysis(ws, a);
                        notify({ kind: "info", text: `Created analysis "${a.name}"` });
                    },
                    (e) => notify({ kind: "error", text: `Failed: ${e.type}` }),
                );
            }}
            onCancel={() => ws.closeDialog()}
        />
    );
}

function SwitchAnalysisDialog(): JSX.Element {
    const ws = useWorkspace();
    const analyses = listRecentAnalyses().match(
        (as) => as,
        () => [],
    );
    const items = analyses.map((a) => ({ value: a, title: a.name, description: a.slug }));
    return (
        <SelectDialog
            title="Switch analysis"
            placeholder={`Search analyses${GLYPHS.ellipsis}`}
            items={items}
            emptyText="No analyses yet — use ctrl+k → New analysis to create one"
            onCancel={() => ws.closeDialog()}
            onSelect={(a: Analysis) => {
                ws.closeDialog();
                openAnalysis(ws, a);
            }}
        />
    );
}

function SwitchSessionDialog(): JSX.Element {
    const ws = useWorkspace();
    const a = ws.analysis;
    const sessions = a
        ? listSessionsByAnalysis(a.id).match(
              (ss) => ss,
              () => [],
          )
        : [];
    sessions.sort((x, y) => y.updatedAt - x.updatedAt);
    const items = sessions.map((s) => ({ value: s, title: s.title, description: new Date(s.updatedAt).toLocaleString() }));
    return (
        <SelectDialog
            title="Switch session"
            placeholder={`Search sessions${GLYPHS.ellipsis}`}
            items={items}
            emptyText="Only one session — send a message to start, or switch analysis first"
            onCancel={() => ws.closeDialog()}
            onSelect={(s: Session) => {
                ws.closeDialog();
                // `a` is non-null: this command is enabled only when an analysis is open.
                ws.openSession(s.id, ws.workingDir, a!);
            }}
        />
    );
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

/** Confirm-to-delete: type the entity name to proceed. Prevents accidental destructive deletes. */
function ConfirmDeleteDialog(props: { entityLabel: string; entityName: string; onConfirm: () => void }): JSX.Element {
    const ws = useWorkspace();
    return (
        <PromptDialog
            title={`Delete ${props.entityLabel}?`}
            tone="danger"
            placeholder={`Type "${props.entityName}" to confirm`}
            onCancel={() => ws.closeDialog()}
            onSubmit={(raw) => {
                if (raw.trim() !== props.entityName) {
                    notify({ kind: "warn", text: "Name does not match — deletion cancelled." });
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
                    description: `Move the workspace to ${archivedOutputSubdir(props.analysis.slug)}/ — inputs, run artifacts, reports, and provenance are preserved`,
                },
                {
                    value: "delete" as const,
                    title: "Delete the files permanently",
                    description: "Remove the workspace directory and everything in it. This cannot be undone",
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
 * Retire the workspace, then delete the row — in that order, and only proceeding if the first
 * succeeds. The filesystem move is the operation that realistically fails (permissions, an open
 * handle); doing it first means such a failure changes nothing at all. The reverse order would
 * leave the row deleted and the tree still sitting at `analyses/<slug>`, where the next analysis
 * of the same name would inherit it — the precise outcome the disposal exists to prevent.
 */
function deleteAnalysisWith(ctx: Workspace, a: Analysis, disposal: "archive" | "delete"): void {
    disposeWorkspace(a, disposal).match(
        (outcome) => {
            const fate =
                outcome.kind === "archived" ? `files kept at ${outcome.path}` : outcome.kind === "deleted" ? "files deleted" : "it had no files on disk";
            deleteAnalysis(a.id).match(
                (changed) => {
                    if (changed === 0) {
                        notify({ kind: "warn", text: "Analysis not found." });
                        return;
                    }
                    notify({ kind: "info", text: `Deleted analysis "${a.name}" — ${fate}` });
                    const remaining = listRecentAnalyses().match(
                        (as) => as,
                        () => [],
                    );
                    if (remaining.length > 0) {
                        openAnalysis(ctx, remaining[0]!);
                    } else {
                        void ctx.quit();
                    }
                },
                (e) => notify({ kind: "error", text: `Workspace retired, but the analysis row could not be deleted (${e.type}).` }),
            );
        },
        (e) =>
            notify({
                kind: "error",
                text:
                    e.type === "workspace_unavailable"
                        ? e.message
                        : `Could not retire the workspace folder (${e.type}) — the analysis was NOT deleted, so nothing was lost.`,
            }),
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

function RemoveInputDialog(): JSX.Element {
    const ws = useWorkspace();
    const a = ws.analysis;
    const inputs = a
        ? listAnalysisInputs(a.id).match(
              (xs) => xs,
              () => [],
          )
        : [];
    const items = inputs.map((input: AnalysisInput) => ({
        value: input,
        title: input.path,
        description: input.isDir ? "directory" : "file",
    }));
    return (
        <SelectDialog
            title="Remove input"
            placeholder={`Search inputs${GLYPHS.ellipsis}`}
            items={items}
            emptyText="No inputs to remove"
            onCancel={() => ws.closeDialog()}
            onSelect={(input: AnalysisInput) => {
                ws.closeDialog();
                if (!a) return;
                removeInput(input).match(
                    () => notify({ kind: "info", text: `Removed input: ${input.path}` }),
                    (e) => notify({ kind: "error", text: `Failed: ${e.type}` }),
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

function RenameSessionDialog(): JSX.Element {
    const ws = useWorkspace();
    return (
        <PromptDialog
            title="Rename session"
            placeholder="New title"
            onCancel={() => ws.closeDialog()}
            onSubmit={(raw) => {
                ws.closeDialog();
                if (!raw.trim()) {
                    notify({ kind: "warn", text: "A title is required." });
                    return;
                }
                renameSession(ws.sessionId, raw.trim()).match(
                    () => notify({ kind: "info", text: `Session renamed to "${raw.trim()}"` }),
                    (e) => notify({ kind: "error", text: `Failed: ${e.type}` }),
                );
            }}
        />
    );
}

/** The single source of truth. Add a command = add an entry here. Ordered by category so the
 *  unfiltered palette groups contiguously. */
// Serialize the active analysis's provenance and write it into its output folder, then notify the
// path. The PROV-building module (`prov/document.ts`) is imported LAZILY inside the action — it
// depends on `@inflexa-ai/tsprov`, so a static import here would pull that into the TUI's startup
// path; deferring it both keeps launch lean and contains any tsprov load failure to this action.
async function exportProvenanceToFile(ws: Workspace, format: BuiltinProvFormat): Promise<void> {
    const a = ws.analysis;
    if (!a) return;

    let prov: typeof import("../modules/prov/document.ts");
    let output: typeof import("../modules/analysis/output.ts");
    let verify: typeof import("../modules/prov/verify.ts");
    try {
        prov = await import("../modules/prov/document.ts");
        output = await import("../modules/analysis/output.ts");
        verify = await import("../modules/prov/verify.ts");
    } catch {
        notify({ kind: "error", text: "Provenance export is unavailable (the tsprov library failed to load)." });
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

    const text = prov.serializeProvenance(a, format).match(
        (t) => t,
        (e) => {
            notify({ kind: "error", text: `Failed to build provenance: ${e.type}` });
            return null;
        },
    );
    if (!text) return;

    const dest = join(dir, `provenance.${format}`);
    const writeResult = mkdirResult(dir, "exportProvenance:mkdir").andThen(() => writeFileResult(dest, text, "exportProvenance:write"));
    if (writeResult.isErr()) {
        notify({ kind: "error", text: `Failed to write provenance: ${String(writeResult.error.cause)}` });
        return;
    }

    // Provenance + sidecar are one logical export: both must succeed before we report success.
    const sidecarResult = await verify.buildSidecar(text);
    if (sidecarResult.isErr()) {
        notify({ kind: "error", text: `Signing failed (${sidecarResult.error.type}) — provenance is never exported unsigned.` });
        return;
    }
    const sigDest = `${dest}.sig.json`;
    const sidecarWrite = writeFileResult(sigDest, JSON.stringify(sidecarResult.value, null, 2), "exportProvenance:sidecar");
    if (sidecarWrite.isErr()) {
        notify({ kind: "error", text: `Wrote provenance but sidecar failed: ${String(sidecarWrite.error.cause)}` });
        return;
    }

    notify({ kind: "info", text: `Wrote ${format} provenance to ${dest}` });
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
    const atCap = rows.length === RUNS_PICKER_LIMIT;
    ctx.openDialog(() => (
        <SelectDialog
            title={atCap ? `${title} (newest ${RUNS_PICKER_LIMIT})` : title}
            placeholder={`Search runs${GLYPHS.ellipsis}`}
            items={rows.map((run) => {
                // Title first, id tail always appended: two runs of the SAME plan share a title, so
                // the tail is what tells them apart.
                const label = (run.planId ? titleByPlanId.get(run.planId) : undefined) ?? shortRunName(run);
                return {
                    value: run,
                    // Title alone on its own (wrapping) line — plan titles run long (up to 80 chars).
                    title: label,
                    // Id tail + status + compact started date as a left-aligned second line (`meta`, not
                    // an inline `hint`): the long title would otherwise collide with the metadata mid-wrap.
                    // The id tail lives here (not the title) so two runs of one plan differ on this line.
                    // Durable-record rule — the picker lists referenced records, so absolute times; the
                    // detail line below expands the focused row to full seconds-bearing started/finished.
                    meta: `${idTail(run.runId)} ${GLYPHS.middot} ${run.status} ${GLYPHS.middot} ${absTimeShort(run.startedAt)}`,
                    description: `started ${absTime(run.startedAt)}${run.completedAt ? ` ${GLYPHS.middot} finished ${absTime(run.completedAt)}` : ""}`,
                };
            })}
            emptyText="no runs"
            onCancel={() => ctx.closeDialog()}
            onSelect={(run: CortexRunRow) => {
                ctx.openDialog(() => (
                    <RunDetailDialog run={run} loadSteps={(runId) => queryStepsByRun(runtime.pool, runId)} onClose={() => ctx.closeDialog()} />
                ));
            }}
        />
    ));
}

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
        id: "analysis.remove-input",
        title: "Remove input",
        description: "Remove an input from this analysis",
        category: "Analysis",
        enabled: (ctx) => ctx.analysis !== null,
        run: (ctx) => ctx.openDialog(() => <RemoveInputDialog />),
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
        description: "Delete this analysis and its sessions; choose whether to keep its files",
        category: "Analysis",
        enabled: (ctx) => ctx.analysis !== null,
        run: async (ctx) => {
            const a = ctx.analysis;
            if (!a) return;
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
                        ctx.openDialog(() => <DeleteAnalysisFilesDialog analysis={a} onDecided={(disposal) => deleteAnalysisWith(ctx, a, disposal)} />);
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
        run: (ctx) => exportProvenanceToFile(ctx, "json"),
    },
    {
        id: "prov.export-provn",
        title: "Export provenance (PROV-N)",
        description: "Write this analysis's PROV-N provenance to its output folder",
        category: "Analysis",
        enabled: (ctx) => ctx.analysis !== null,
        run: (ctx) => exportProvenanceToFile(ctx, "provn"),
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
            try {
                verify = await import("../modules/prov/verify.ts");
            } catch {
                notify({ kind: "error", text: "Provenance verification is unavailable." });
                return;
            }

            const result = await verify.verifyAnalysisIntegrity(a.id);
            if (!result) {
                notify({ kind: "error", text: "Could not read provenance data." });
                return;
            }

            notify({ kind: noticeKindFor(result), text: verify.formatVerifyResult(result) });
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
            let output: typeof import("../modules/analysis/output.ts");
            try {
                verify = await import("../modules/prov/verify.ts");
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
            notify({ kind: noticeKindFor(result), text: verify.formatVerifyResult(result) });
        },
    },
    {
        id: "session.switch",
        title: "Switch session",
        description: "Switch to another session in this analysis",
        category: "Session",
        enabled: (ctx) => ctx.analysis !== null,
        run: (ctx) => ctx.openDialog(() => <SwitchSessionDialog />),
    },
    {
        id: "session.rename",
        title: "Rename session",
        description: "Change the current session's title",
        category: "Session",
        run: (ctx) => ctx.openDialog(() => <RenameSessionDialog />),
    },
    {
        id: "session.delete",
        title: "Delete session",
        description: "Permanently delete the current session and its messages",
        category: "Session",
        enabled: (ctx) => ctx.analysis !== null,
        run: (ctx) => {
            const a = ctx.analysis;
            if (!a) return;
            const sessionTitle = getSession(ctx.sessionId).match(
                (s) => s?.title ?? "this session",
                () => "this session",
            );
            ctx.openDialog(() => (
                <ConfirmDeleteDialog
                    entityLabel="session"
                    entityName={sessionTitle}
                    onConfirm={() => {
                        deleteSession(ctx.sessionId).match(
                            (changed) => {
                                if (changed === 0) {
                                    notify({ kind: "warn", text: "Session not found." });
                                    return;
                                }
                                notify({ kind: "info", text: "Session deleted." });
                                openAnalysis(ctx, a);
                            },
                            (e) => notify({ kind: "error", text: `Failed: ${e.type}` }),
                        );
                    }}
                />
            ));
        },
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
