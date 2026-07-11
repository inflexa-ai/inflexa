import { Show, type JSX } from "solid-js";
import { existsSync } from "node:fs";
import { join } from "node:path";
// Type-only — erased at compile time, so it does NOT pull tsprov/verify into the TUI's startup path.
import type { BuiltinProvFormat } from "@inflexa-ai/tsprov";
import type { VerifyResult } from "../types/prov.ts";

import { PromptDialog } from "./components/dialog/prompt_dialog.tsx";
import { ResultsDialog } from "./components/dialog/results_dialog.tsx";
import { SelectDialog } from "./components/dialog/select_dialog.tsx";
import { FilePicker } from "./components/dialog/file_picker.tsx";
import { ConfigApp } from "./app_config.tsx";
import { DesignGallery } from "./layout/design_gallery.tsx";
import { setTheme, theme } from "./theme.ts";
import { notify } from "./hooks/notice.ts";
import { queryRunsByAnalysis } from "@inflexa-ai/harness";

import { bootState, harnessRuntime } from "./hooks/boot.ts";
import { driveForceReprofile, profileWorkInFlight } from "./hooks/profile_parity.ts";
import { RUN_STATUS_TERMINAL } from "./hooks/sidebar_live.ts";
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
import { listConnectionModels } from "../modules/harness/model_listing.ts";
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
 * The agent-parameterized model picker: a {@link SelectDialog} over the
 * connection's live models with the agent's CURRENT model marked, degrading to a {@link PromptDialog}
 * free-text entry when listing failed (`models === null`). Purely presentational — the command
 * resolves the listing and wires `onSubmit` (persist + apply) and `onCancel` (close) — so it renders as an
 * inert design-gallery/test exhibit unchanged.
 */
export function ModelPickerDialog(props: {
    agent: AgentName;
    /** The connection's model ids, or `null` when listing failed (degrade to free-text entry). */
    models: readonly string[] | null;
    /** The agent's currently-running model, marked `current` in the list and pre-filled in the free-text field. */
    current: string;
    /** Persist + apply the chosen/typed model. */
    onSubmit: (model: string) => void;
    /** Close without changing anything (esc, click-outside, ctrl+c). */
    onCancel: () => void;
}): JSX.Element {
    // A thunk so the fixed-per-mount `props.agent` read lands inside JSX (a tracked scope), satisfying
    // solid/reactivity without destructuring or a disable.
    const title = (): string => (props.agent === "conversation" ? "Switch chat model" : "Switch sandbox model");
    return (
        <Show
            when={props.models}
            keyed
            fallback={
                <PromptDialog
                    title={title()}
                    value={props.current}
                    placeholder="Enter a model id"
                    description={() => <text fg={theme().fgMuted}>Could not list the connection's models — enter a model id manually.</text>}
                    onCancel={props.onCancel}
                    onSubmit={props.onSubmit}
                />
            }
        >
            {(models: readonly string[]) => (
                <SelectDialog
                    title={title()}
                    placeholder={`Search models${GLYPHS.ellipsis}`}
                    items={models.map((id) => ({ value: id, title: id, hint: id === props.current ? "current" : undefined }))}
                    emptyText="No models listed by the connection"
                    onCancel={props.onCancel}
                    onSelect={props.onSubmit}
                />
            )}
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
            onSubmit={(model) => {
                ctx.closeDialog();
                const id = model.trim();
                if (!id) {
                    notify({ kind: "warn", text: "A model id is required." });
                    return;
                }
                applyAgentSelection(agent, id);
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

function StatusDialog(): JSX.Element {
    const ws = useWorkspace();
    const line = resolveContext(ws.workingDir, {}).match(
        (c) => describeContext(c),
        (e) => `Failed to resolve context: ${e.type}`,
    );
    return <ResultsDialog title="Status" lines={[line]} emptyText="No context" onClose={() => ws.closeDialog()} />;
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
        description: "What inflexa resolves to here",
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
