import type { JSX } from "solid-js";
import { existsSync } from "node:fs";
import { join } from "node:path";
// Type-only — erased at compile time, so it does NOT pull tsprov/verify into the TUI's startup path.
import type { BuiltinProvFormat } from "@inflexa-ai/tsprov";
import type { VerifyResult } from "../types/prov.ts";

import { PromptDialog } from "./components/dialog/prompt_dialog.tsx";
import { ResultsDialog } from "./components/dialog/results_dialog.tsx";
import { SelectList } from "./components/select_list.tsx";
import { ConfigApp } from "./app_config.tsx";
import { DesignGallery } from "./layout/design_gallery.tsx";
import { setTheme } from "./theme.ts";
import { notify } from "./hooks/notice.ts";
import { keybindLabel } from "./keymap.ts";
import { useWorkspace, type Workspace } from "./contexts/workspace.ts";
import { GLYPHS, themes, themeIds, type ThemeId } from "../lib/design_system.ts";
import { readConfig, writeConfig } from "../lib/config.ts";
import { mkdirResult, writeFileResult } from "../lib/fs.ts";
import { str256 } from "../lib/types.ts";
import { createAnalysis, listRecentAnalyses, uniqueSlugForAnchor, addInputs, removeInput, matchAnalysis } from "../modules/analysis/analysis.ts";
import { resolveContext, describeContext } from "../modules/analysis/context.ts";
import { openOutputDir } from "../modules/analysis/open.ts";
import { resolveAnchor, resolvedPathOrCached } from "../modules/anchor/anchor.ts";
import { loadAuth, describeAuthError } from "../modules/auth/auth.ts";
import { decodeIdTokenClaims } from "../modules/auth/whoami.ts";
import {
    createProject,
    createSession,
    deleteAnalysis,
    deleteProject,
    deleteSession,
    renameSession,
    renameAnalysis,
    updateAnalysisProject,
} from "../db/primary_mutation.ts";
import { getSession, listSessionsByAnalysis, listProjects, listAnalysisInputs, countAnalysesByProject } from "../db/primary_query.ts";
import type { Analysis, AnalysisInput } from "../types/analysis.ts";
import type { Session } from "../types/session.ts";
import type { Project } from "../types/project.ts";

// The command registry: the SINGLE source of truth for the palette. Adding a command is one
// entry in `commands`. Each command's `run` acts only through the `Workspace` (the context store
// built in `App`), never stdout — the alt-screen owns the terminal. Command-specific dialogs are
// co-located here as single-caller helpers; the reusable dialog shells live in `components/`.

/** The categories a command groups under in the palette. A domain type, never a raw string. */
export type CommandCategory = "Analysis" | "Session" | "Project" | "View" | "App";

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
        <SelectList
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
                    (name) =>
                        // A deliberate action, so minting the anchor marker here is allowed (no-litter policy).
                        createAnalysis({ cwd: ws.workingDir, name }).match(
                            (a) => {
                                openAnalysis(ws, a);
                                notify({ kind: "info", text: `Created analysis "${a.name}"` });
                            },
                            (e) => notify({ kind: "error", text: `Failed: ${e.type}` }),
                        ),
                    (err) => notify({ kind: "warn", text: err === "empty" ? "A name is required." : "Keep the name to 256 characters or fewer." }),
                );
            }}
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
        <SelectList
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
        <SelectList
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
        <SelectList
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
    return (
        <PromptDialog
            title="Add input"
            placeholder="File or directory path (relative to analysis root)"
            onCancel={() => ws.closeDialog()}
            onSubmit={(raw) => {
                ws.closeDialog();
                const a = ws.analysis;
                if (!a || !raw.trim()) return;
                addInputs(a.id, [raw.trim()], ws.workingDir).match(
                    () => notify({ kind: "info", text: `Added input: ${raw.trim()}` }),
                    (e) => notify({ kind: "error", text: `Failed: ${e.type}` }),
                );
            }}
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
        <SelectList
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
                        uniqueSlugForAnchor(a.anchorId, name)
                            .andThen((slug) => renameAnalysis(a.id, name, slug))
                            .match(
                                () => {
                                    notify({ kind: "info", text: `Renamed to "${raw.trim()}"` });
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
        run: (ctx) => ctx.openDialog(() => <RenameAnalysisDialog />),
    },
    {
        id: "analysis.add-input",
        title: "Add input",
        description: "Add a file or directory as an input to this analysis",
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
        description: "Permanently delete this analysis and its sessions",
        category: "Analysis",
        enabled: (ctx) => ctx.analysis !== null,
        run: (ctx) => {
            const a = ctx.analysis;
            if (!a) return;
            ctx.openDialog(() => (
                <ConfirmDeleteDialog
                    entityLabel="analysis"
                    entityName={a.name}
                    onConfirm={() => {
                        deleteAnalysis(a.id).match(
                            (changed) => {
                                if (changed === 0) {
                                    notify({ kind: "warn", text: "Analysis not found." });
                                    return;
                                }
                                notify({ kind: "info", text: `Deleted analysis "${a.name}"` });
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
                            (e) => notify({ kind: "error", text: `Failed: ${e.type}` }),
                        );
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
                (e) => notify({ kind: "error", text: `Failed to open: ${e.type}` }),
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
                <SelectList
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
