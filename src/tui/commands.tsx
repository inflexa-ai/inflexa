import type { JSX } from "solid-js";

import { PromptDialog } from "./components/prompt_dialog.tsx";
import { ResultsDialog } from "./components/results_dialog.tsx";
import { SelectList } from "./components/select_list.tsx";
import { ConfigApp } from "./app_config.tsx";
import { setTheme } from "./theme.ts";
import { notify } from "./hooks/notice.ts";
import { keybindLabel } from "./keymap.ts";
import { useWorkspace, type Workspace } from "./contexts/workspace.ts";
import { themes, themeIds, type ThemeId } from "../lib/themes.ts";
import { GLYPHS } from "../lib/glyphs.ts";
import { readConfig, writeConfig } from "../lib/config.ts";
import { str256 } from "../lib/types.ts";
import { createAnalysis, listRecentAnalyses } from "../modules/analysis/analysis.ts";
import { resolveContext, describeContext } from "../modules/analysis/context.ts";
import { openOutputDir } from "../modules/analysis/open.ts";
import { resolveAnchor } from "../modules/anchor/anchor.ts";
import { createProject, createSession } from "../db/primary_mutation.ts";
import { listSessionsByAnalysis } from "../db/primary_query.ts";
import type { Analysis } from "../types/analysis.ts";
import type { Session } from "../types/session.ts";

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
        ({ anchor, path }) => path ?? anchor.cachedPath,
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
            emptyText="No analyses yet"
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
            emptyText="No sessions for this analysis"
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
    // Embedded mode: ConfigApp hands control back via onClose instead of tearing down the renderer.
    return <ConfigApp onClose={() => ws.closeDialog()} />;
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
        id: "session.switch",
        title: "Switch session",
        description: "Switch to another session in this analysis",
        category: "Session",
        enabled: (ctx) => ctx.analysis !== null,
        run: (ctx) => ctx.openDialog(() => <SwitchSessionDialog />),
    },
    {
        id: "project.new",
        title: "New project",
        description: "Create a project grouping",
        category: "Project",
        run: (ctx) => ctx.openDialog(() => <NewProjectDialog />),
    },
    {
        id: "view.status",
        title: "Show status",
        description: "What inf resolves to here",
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
        id: "app.quit",
        title: "Quit",
        description: "Exit inf",
        category: "App",
        // Display-only: ctrl+c (the abort chord) doubles as the exit affordance shown in the palette.
        keybind: keybindLabel("app.abort"),
        run: (ctx) => {
            void ctx.quit();
        },
    },
];
