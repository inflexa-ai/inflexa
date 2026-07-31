import type { JSX } from "solid-js";
import { TextareaRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { okAsync } from "neverthrow";
import type { DbError, StepExecutionRow } from "@inflexa-ai/harness";

import { GLYPHS, size, space } from "../../lib/design_system.ts";
import { theme } from "../theme.ts";
import { KEYS, chordLabel, keybindLabel, interruptHintLabel } from "../keymap.ts";
import { useDialogBindings, useDialogCancel, useDialogEntry, DialogShowcase } from "../components/dialog/dialog_host.tsx";
import { DialogPanel } from "../components/dialog/dialog_panel.tsx";
import { PromptDialog } from "../components/dialog/prompt_dialog.tsx";
import { ConfirmDialog } from "../components/dialog/confirm_dialog.tsx";
import { AlertDialog } from "../components/dialog/alert_dialog.tsx";
import { ResultsDialog } from "../components/dialog/results_dialog.tsx";
import { ExportOptionsDialog } from "../components/dialog/export_options_dialog.tsx";
import { PlanStepDetailDialog } from "../components/dialog/plan_step_detail_dialog.tsx";
import { Welcome } from "../components/welcome.tsx";
import { ThinkingBlock } from "../components/thinking_block.tsx";
import { ThinkingIndicator } from "../components/thinking_indicator.tsx";
import { BootIndicator } from "../components/boot_indicator.tsx";
import { ToolBlock } from "../components/tool_block.tsx";
import { DiffBlock } from "../components/diff_block.tsx";
import { RunBlock } from "../components/run_block.tsx";
import { RunCardBlock } from "../components/run_card_block.tsx";
import { ErrorBlock } from "../components/error_block.tsx";
import { PresentationBlock } from "../components/presentation_block.tsx";
import { OpenableCardBlock } from "../components/openable_card_block.tsx";
import { PlanCardBlock } from "../components/plan_card_block.tsx";
import { AskPrompt } from "../components/ask_prompt.tsx";
import { MessageBlock } from "./message_block.tsx";
import { ChatBar } from "./chat_bar.tsx";
import { ActivityPanel } from "./activity_panel.tsx";
import { Bold, Italic, Underline, Dim, Reverse, Fg } from "../components/emphasis.tsx";
import { TextArea } from "../components/text_area.tsx";
import { TextInput } from "../components/text_input.tsx";
import { ScrollPane } from "../components/scroll_pane.tsx";
import { FixedList } from "../components/fixed_list.tsx";
import { SelectDialog } from "../components/dialog/select_dialog.tsx";
import { FilePicker } from "../components/dialog/file_picker.tsx";
import { RunDetailDialog } from "../components/dialog/run_detail_dialog.tsx";
import {
    absTime,
    idTail,
    profileDetailLines,
    shortRunName,
    type ActiveProfileProgress,
    type ActiveRunProgress,
    type PanelSubject,
} from "../hooks/sidebar_live.ts";
import {
    mockUserText,
    mockAssistantText,
    mockThinking,
    mockToolCall,
    mockFileEdit,
    mockRun,
    mockLongRun,
    mockPlanCard,
    mockPlanGraphExhibits,
    mockPlanStepDetail,
    mockRunCard,
    mockRunCardIds,
    galleryProfile,
    galleryRun,
    mockAskPrompts,
    mockAskCards,
    mockCortexRuns,
    mockRunSteps,
    mockDataProfile,
} from "./design_gallery_fixtures.ts";

// Nothing streams in the gallery — MessageBlock's streaming accessors are constant stubs.
const noStreamId = (): string | null => null;
const noStreamText = (): string => "";

const noop = (): void => {
    /* gallery showcase: submit is a no-op since inputs are non-interactive */
};

// The run-activity panel takes a discriminated subject, and the exhibits vary the fixture rather than
// the kind — so wrapping happens here once instead of at each of the eight call sites, where the
// literal would bury the field the exhibit is actually demonstrating.
const runSubject = (over?: Partial<ActiveRunProgress>): PanelSubject => ({ kind: "run", run: galleryRun(over) });
const profileSubject = (over?: Partial<ActiveProfileProgress>): PanelSubject => ({ kind: "profile", profile: galleryProfile(over) });

function State(props: { n: string; label: string; children: JSX.Element }): JSX.Element {
    return (
        <box flexDirection="column" paddingBottom={space.md}>
            <text fg={theme().accent}>
                {props.n} {props.label}
            </text>
            {props.children}
        </box>
    );
}

/**
 * A read-only showcase of every design-system stream-block state, rendered from the MOCK fixtures
 * (see `design_gallery_fixtures`). Every state renders faithfully here: it drives
 * the block widgets directly, bypassing the live conversation store and event bus entirely, so no
 * mock data ever leaks into a real session. Esc/q close.
 */
export function DesignGallery(props: { onClose: () => void }): JSX.Element {
    const dialog = useDialogEntry();
    const renderer = useRenderer();

    useDialogCancel(() => props.onClose());

    // Scroll keys (and focus-on-mount) come from ScrollPane; esc/cancel is the host's. `q` is a
    // bare printable, and the exhibits include CLICKABLE editors (the TextArea/TextInput states
    // invite focusing them), so the layer gates itself off while any editor holds focus — the
    // keymap dispatches before the focused editor and would otherwise eat the typed character
    // (the bare-printable-key rule). InputRenderable extends TextareaRenderable, so one
    // instanceof covers both primitives. Read at dispatch time (the config thunk re-runs per
    // keystroke), so no reactive focus mirror is needed.
    useDialogBindings(() => ({
        enabled: !(renderer.currentFocusedRenderable instanceof TextareaRenderable),
        bindings: [{ chord: KEYS.q, run: () => props.onClose() }],
    }));
    const runSteps = mockRun.steps.map((s) => ({ label: s.label, state: s.state, startedAt: s.startedAt }));
    const longRunSteps = mockLongRun.steps.map((s) => ({ label: s.label, state: s.state }));
    // The live interrupt + abort chords, so the footer-hint exhibits below name the real keys (esc in
    // NORMAL, the one-press ctrl+c in INSERT) rather than hardcoded ones.
    const interruptKey = keybindLabel("app.interrupt");
    const abortKey = keybindLabel("app.abort");
    // Derived, exactly as the real mount derives them — the exhibits must advertise the live chords.
    const activityPanelNextKey = keybindLabel("app.activity-panel-next");
    const activityPanelToggleKey = keybindLabel("app.activity-panel-toggle");
    return (
        <DialogPanel title="Design system — stream blocks" size="xl" footer={`${chordLabel(KEYS.escape)}/${chordLabel(KEYS.q)} close`}>
            <ScrollPane focusOnMount={false} onRef={(r) => dialog?.setInitialFocus(r)} flexGrow={1} width="100%" paddingTop={space.sm}>
                <State n="1" label="welcome / startup">
                    <Welcome greeting="welcome to inflexa" anchorPath="~/inflexa-tests" markerWritten={true} hints={["run /init", "ctrl+k for commands"]} />
                </State>
                <State n="2" label="plain chat turn">
                    <MessageBlock index={1} role="user" parts={[mockUserText]} streamPartId={noStreamId} streamText={noStreamText} />
                    <MessageBlock
                        index={2}
                        role="assistant"
                        durationMs={2400}
                        parts={[mockAssistantText]}
                        streamPartId={noStreamId}
                        streamText={noStreamText}
                    />
                </State>
                <State n="3" label="thinking / reasoning (live indicator, collapsed, expanded)">
                    {/* Self-animating: it owns its spinner interval, so it spins live in the gallery. */}
                    <ThinkingIndicator />
                    <ThinkingBlock text={mockThinking.text} durationMs={mockThinking.durationMs} />
                    <ThinkingBlock text={mockThinking.text} durationMs={mockThinking.durationMs} expanded />
                </State>
                <State n="4" label="tool call & result">
                    <ToolBlock
                        name={mockToolCall.name}
                        detail={mockToolCall.detail}
                        result={mockToolCall.result}
                        filetype={mockToolCall.filetype}
                        status={mockToolCall.status}
                    />
                </State>
                <State n="5" label="long-running run / task">
                    <RunBlock name={mockRun.name} tag={mockRun.tag} done={mockRun.done} total={mockRun.total} steps={runSteps} />
                </State>
                <State n="6" label="diff / file edit">
                    <DiffBlock path={mockFileEdit.path} diff={mockFileEdit.diff} added={mockFileEdit.added} removed={mockFileEdit.removed} />
                </State>
                <State n="7" label="error / abort">
                    <ErrorBlock
                        summary="aborted (ctrl+c) · step 13 stopped, 12 kept"
                        detail="EACCES · anchor not writable"
                        note="marker_written=false → degraded to path-only; identity no longer self-heals on move."
                        hints={["/reanchor", "r retry", "esc dismiss"]}
                    />
                </State>
                <State n="8" label="command palette">
                    <text fg={theme().fgMuted}>
                        Press {GLYPHS.middot} ctrl+k {GLYPHS.middot} in the chat to open the live command palette overlay.
                    </text>
                </State>
                {/* Exhibits mount blurred (autoFocus={false}): a focused-at-mount editor would
                    steal the gallery pane's focus, surviving only by microtask ordering. */}
                <State n="9" label="TextArea — full / compact / bare chrome">
                    <text fg={theme().fgMuted}>click a textarea to focus it and see the NORMAL {GLYPHS.arrowRight} INSERT mode shift</text>
                    <text fg={theme().fgMuted}>full (border signals focus, host adds footer):</text>
                    <TextArea chrome="full" autoFocus={false} placeholder={`Type a message${GLYPHS.ellipsis}`} onSubmit={noop} />
                    <text fg={theme().fgMuted}>compact (mode word in border title):</text>
                    <TextArea chrome="compact" autoFocus={false} placeholder={`Enter a name${GLYPHS.ellipsis}`} onSubmit={noop} />
                    <text fg={theme().fgMuted}>bare (background shift only):</text>
                    <TextArea chrome="bare" autoFocus={false} placeholder={`Bare textarea${GLYPHS.ellipsis}`} onSubmit={noop} />
                </State>
                <State n="10" label="TextInput — compact / bare chrome">
                    <text fg={theme().fgMuted}>compact (bordered, focus shifts border):</text>
                    <TextInput chrome="compact" autoFocus={false} placeholder={`Filter${GLYPHS.ellipsis}`} />
                    <text fg={theme().fgMuted}>bare (no border):</text>
                    <TextInput chrome="bare" autoFocus={false} placeholder={`Type to filter${GLYPHS.ellipsis}`} />
                </State>
                <State n="11" label="dialogs — sizes, tones, and the content family (inert exhibits)">
                    <text fg={theme().fgMuted}>PromptDialog — single-line (md, TextInput, no mode word):</text>
                    <DialogShowcase>
                        <PromptDialog title="New project" placeholder="Project name" onSubmit={noop} onCancel={noop} />
                    </DialogShowcase>
                    <text fg={theme().fgMuted}>PromptDialog — multiline (TextArea, ctrl+j newline):</text>
                    <DialogShowcase>
                        <PromptDialog
                            title="Description"
                            multiline
                            height={3}
                            placeholder={`A longer text${GLYPHS.ellipsis}`}
                            onSubmit={noop}
                            onCancel={noop}
                        />
                    </DialogShowcase>
                    <text fg={theme().fgMuted}>PromptDialog — busy (spinner in footer, dismissal vetoed):</text>
                    <DialogShowcase>
                        <PromptDialog title="Rename" value="analysis-1" busy busyText={`Renaming${GLYPHS.ellipsis}`} onSubmit={noop} onCancel={noop} />
                    </DialogShowcase>
                    <text fg={theme().fgMuted}>danger tone (double border — destructive confirms):</text>
                    <DialogShowcase>
                        <PromptDialog title="Delete project?" tone="danger" placeholder={`Type "acme" to confirm`} onSubmit={noop} onCancel={noop} />
                    </DialogShowcase>
                    <text fg={theme().fgMuted}>ConfirmDialog — binary choice, cancel is the safe default:</text>
                    <DialogShowcase>
                        <ConfirmDialog title="Discard changes?" message="Unsaved edits will be lost." onConfirm={noop} onCancel={noop} />
                    </DialogShowcase>
                    <text fg={theme().fgMuted}>AlertDialog — single acknowledgement:</text>
                    <DialogShowcase>
                        <AlertDialog title="Heads up" message="The proxy restarted." onClose={noop} />
                    </DialogShowcase>
                    <text fg={theme().fgMuted}>ResultsDialog — read-only scrollable lines (lg, fixed height):</text>
                    <DialogShowcase>
                        <ResultsDialog title="Projects" lines={["acme — 3 analyses", "demo — 1 analysis"]} emptyText="No projects yet" onClose={noop} />
                    </DialogShowcase>
                    <text fg={theme().fgMuted}>ResultsDialog — with a single-key footer action affordance (inert here):</text>
                    <DialogShowcase>
                        <ResultsDialog
                            title="Data profile"
                            lines={["status: completed", "12 files"]}
                            emptyText="no profile data"
                            action={{ key: "r", label: "re-profile", enabled: true, onAction: noop }}
                            onClose={noop}
                        />
                    </DialogShowcase>
                    <text fg={theme().fgMuted}>ExportOptionsDialog — text field + checkbox options:</text>
                    <DialogShowcase>
                        <ExportOptionsDialog
                            title="Export report"
                            textField={{ label: "Filename", defaultValue: "report.html", placeholder: "report.html" }}
                            items={[
                                { key: "figures", label: "Include figures", defaultValue: true },
                                { key: "raw", label: "Include raw data", defaultValue: false },
                            ]}
                            onConfirm={noop}
                            onCancel={noop}
                        />
                    </DialogShowcase>
                    <text fg={theme().fgMuted}>PlanStepDetailDialog — copied plan-step fields:</text>
                    <DialogShowcase>
                        <PlanStepDetailDialog step={mockPlanStepDetail} onClose={noop} />
                    </DialogShowcase>
                </State>
                <State n="12" label="select lists — FixedList / DynamicList / SelectDialog (inert exhibits)">
                    <text fg={theme().fgMuted}>single mode — {GLYPHS.chevronRight} chevron cursor, headers group by category:</text>
                    <DialogShowcase>
                        <box height={7} width="100%">
                            <FixedList
                                items={[
                                    { value: "tn", title: "Tokyo Night", category: "Dark", description: "the default" },
                                    { value: "cat", title: "Catppuccin Mocha", category: "Dark" },
                                    { value: "lat", title: "Latte", category: "Light" },
                                ]}
                                emptyText="No themes"
                            />
                        </box>
                    </DialogShowcase>
                    <text fg={theme().fgMuted}>single mode, filtered (query "la") — a surviving item keeps its category header:</text>
                    <DialogShowcase>
                        <box height={4} width="100%">
                            <FixedList
                                items={[
                                    { value: "tn", title: "Tokyo Night", category: "Dark" },
                                    { value: "lat", title: "Latte", category: "Light" },
                                ]}
                                query="la"
                                emptyText="No themes"
                            />
                        </box>
                    </DialogShowcase>
                    <text fg={theme().fgMuted}>
                        multi mode — {GLYPHS.circle}/{GLYPHS.circleHollow} gutter, space toggles, enter confirms the batch:
                    </text>
                    <DialogShowcase>
                        <box height={5} width="100%">
                            <FixedList
                                items={[
                                    { value: "a", title: "data/counts.tsv" },
                                    { value: "b", title: "data/meta.csv" },
                                    { value: "c", title: "scripts/" },
                                ]}
                                mode="multi"
                                initialSelected={new Set(["a", "c"])}
                                emptyText="No files"
                            />
                        </box>
                    </DialogShowcase>
                    <text fg={theme().fgMuted}>
                        two-line rows (`meta`) — a long title wraps on line one, id/status/date left-aligned beneath (the runs picker):
                    </text>
                    <DialogShowcase>
                        <box height={6} width="100%">
                            <FixedList
                                items={[
                                    {
                                        value: "r1",
                                        title: "Clinical & mutation associations with anti-PD-1 response in GSE78220 (n=28)",
                                        meta: `e4fc84 ${GLYPHS.middot} completed ${GLYPHS.middot} 7/13/26, 7:23 PM`,
                                    },
                                    {
                                        value: "r2",
                                        title: "GSE78220 follow-up: power, mutation-burden, consolidated summary",
                                        meta: `58a37a ${GLYPHS.middot} running ${GLYPHS.middot} 7/14/26, 3:43 PM`,
                                    },
                                ]}
                                emptyText="No runs"
                            />
                        </box>
                    </DialogShowcase>
                    <text fg={theme().fgMuted}>empty state:</text>
                    <DialogShowcase>
                        <box height={3} width="100%">
                            <FixedList items={[]} emptyText="No matching commands" />
                        </box>
                    </DialogShowcase>
                    <text fg={theme().fgMuted}>SelectDialog — the picker dialog composing panel + filter + FixedList:</text>
                    <DialogShowcase>
                        <SelectDialog
                            title="Switch analysis"
                            items={[
                                { value: "1", title: "rna-seq-2026", description: "differential expression" },
                                { value: "2", title: "scrna-atlas" },
                            ]}
                            emptyText="No analyses"
                            onSelect={noop}
                            onCancel={noop}
                        />
                    </DialogShowcase>
                    <text fg={theme().fgMuted}>FilePicker — multi-select browser on DynamicList (lists the live cwd, inert keys):</text>
                    <DialogShowcase>
                        <FilePicker rootPath={process.cwd()} selectedPaths={new Set()} confirmLabel="Add" onConfirm={noop} onCancel={noop} />
                    </DialogShowcase>
                </State>
                <State n="13" label="type & emphasis">
                    <text>
                        <Fg role="fg">
                            <Bold>bold</Bold>
                        </Fg>{" "}
                        <Fg role="fgMuted">— names, active items</Fg>
                    </text>
                    <text>
                        <Fg role="fg">regular</Fg> <Fg role="fgMuted">— body / assistant text</Fg>
                    </text>
                    <text>
                        <Fg role="fgMuted">
                            <Dim>dim</Dim>
                        </Fg>{" "}
                        <Fg role="fgMuted">— meta, labels, hints (color role preferred)</Fg>
                    </text>
                    <text>
                        <Fg role="fgMuted">
                            <Italic>italic</Italic>
                        </Fg>{" "}
                        <Fg role="fgMuted">— reasoning / quoted (terminal-dependent)</Fg>
                    </text>
                    <text>
                        <Fg role="fg">
                            <Underline>underline</Underline>
                        </Fg>{" "}
                        <Fg role="fgMuted">— links / paths</Fg>
                    </text>
                    <text>
                        {/* Alone in this set, Reverse paints both fg and bg itself, so an outer Fg would fight it. */}
                        <Reverse> reverse </Reverse> <Fg role="fgMuted">— selection / cursor row</Fg>
                    </text>
                </State>
                <State n="14" label="harness boot — live indicator + failed gate">
                    <text fg={theme().fgMuted}>booting (self-animating spinner + elapsed, shown while the runtime boots and the input is gated):</text>
                    {/* Self-animating: it owns its spinner interval, so it spins live in the gallery. */}
                    <BootIndicator />
                    <text fg={theme().fgMuted}>failed (the boot-error taxonomy's actionable message, terminal state — never a hang):</text>
                    <BootIndicator
                        message={[
                            `The proxy's default model "gpt-4o" is not a Claude model, but data profiling drives the proxy over the Anthropic protocol.`,
                            "Authenticate a Claude provider via `inflexa setup`, or set `harness.model` in config.json to a Claude model the proxy serves.",
                        ].join("\n")}
                    />
                </State>
                <State n="15" label="live tool activity — running / done (with duration) / error / denied">
                    {/* The harness emit adapter mints these from tool-started/tool-finished: no result
                        panel (live events carry no output), so the outcome folds onto the name line
                        (`▸ name detail  ✓ ok · 14ms`). `inlineStatus` is pinned true to document the form
                        explicitly; a result-less block would derive it anyway. Contrast State 4, whose
                        result fixture keeps the outcome on its own line below the panel.
                        `denied` is a refused approval — the soft warning glyph, not the error cross. */}
                    {/* Every detail here is the shape the named tool's own `describeCall` really
                        produces — `grep` reports `<pattern> in <path>`, not a glob. An exhibit showing
                        a shape no tool can emit teaches the wrong thing about the surface. */}
                    <ToolBlock name="grep" detail="TP53 in runs/r1/step-2/output" status="running" inlineStatus={true} />
                    <ToolBlock name="read_file" detail="src/db/types.ts :55-105" status="ok" durationMs={1240} inlineStatus={true} />
                    <ToolBlock name="write_file" detail="out/report.html" status="error" durationMs={320} inlineStatus={true} />
                    <ToolBlock name="execute_analysis" detail="plan_01J8F2QK" status="denied" durationMs={4} inlineStatus={true} />
                    <text fg={theme().fgMuted}>the fit is width-dependent — a detail the name line cannot hold drops to its own row, never cut:</text>
                    {/* Near the harness's 120-character detail cap, so this exhibit reflows on any
                        terminal narrower than ~190 columns. A shorter path fits on a wide terminal and
                        the exhibit then silently demonstrates the opposite of its own caption. */}
                    <ToolBlock
                        name="read_file"
                        detail="runs/2026-07-30T09-14-22Z/step-4-pathway-enrichment-and-gsea/output/hallmark_gsea_ranked_by_normalized_enrichment.csv"
                        status="ok"
                        durationMs={14}
                        inlineStatus={true}
                    />
                    <text fg={theme().fgMuted}>a tool that declares no describeCall hook renders exactly as before:</text>
                    <ToolBlock name="search_semantic_scholar" status="ok" durationMs={890} inlineStatus={true} />
                </State>
                <State n="16" label="harness cards — plan card & run card">
                    <MessageBlock index={1} role="assistant" parts={[mockPlanCard]} streamPartId={noStreamId} streamText={noStreamText} />
                    <MessageBlock index={2} role="assistant" parts={[mockRunCard]} streamPartId={noStreamId} streamText={noStreamText} />
                    <text fg={theme().fgMuted}>plan dependency graph — linear:</text>
                    <PlanCardBlock planId="mock-linear" title="Linear plan" steps={mockPlanGraphExhibits.linear} />
                    <text fg={theme().fgMuted}>branching + merge:</text>
                    <PlanCardBlock planId="mock-branching" title="Branching plan" steps={mockPlanGraphExhibits.branching} />
                    <text fg={theme().fgMuted}>wide fan-out (horizontal overflow):</text>
                    <PlanCardBlock planId="mock-wide" title="Wide plan" steps={mockPlanGraphExhibits.wide} />
                    <text fg={theme().fgMuted}>long-label truncation:</text>
                    <PlanCardBlock planId="mock-long-label" title="Long-label plan" steps={mockPlanGraphExhibits.longLabel} />
                    <text fg={theme().fgMuted}>empty fallback:</text>
                    <PlanCardBlock planId="mock-empty" title="Empty plan" steps={mockPlanGraphExhibits.empty} />
                </State>
                <State n="17" label="sidebar details — data profile & runs (inert exhibits)">
                    {/* Profile details reuse ResultsDialog verbatim; the lines are composed by the REAL
                        `profileDetailLines` over a loaded mock snapshot, so the exhibit cannot drift from
                        production output. */}
                    <text fg={theme().fgMuted}>ResultsDialog — data-profile details (composed from a loaded profile snapshot):</text>
                    <DialogShowcase>
                        <ResultsDialog
                            title={`Data profile ${GLYPHS.emDash} rna-seq-2026`}
                            lines={profileDetailLines({ kind: "loaded", profile: mockDataProfile })}
                            emptyText="no profile data"
                            onClose={noop}
                        />
                    </DialogShowcase>
                    <text fg={theme().fgMuted}>runs picker — the searchable SelectDialog all three RUNS entry points open:</text>
                    <DialogShowcase>
                        <SelectDialog
                            title={`Runs ${GLYPHS.emDash} rna-seq-2026`}
                            placeholder={`Search runs${GLYPHS.ellipsis}`}
                            items={mockCortexRuns.map((run) => ({
                                value: run,
                                title: `${shortRunName(run)} ${idTail(run.runId)}`,
                                description: `${run.status} ${GLYPHS.middot} ${absTime(run.startedAt)}`,
                            }))}
                            emptyText="no runs"
                            onCancel={noop}
                        />
                    </DialogShowcase>
                    <text fg={theme().fgMuted}>RunDetailDialog — one picked run's metadata + full step list (done / running / failed / queued):</text>
                    <DialogShowcase>
                        <RunDetailDialog run={mockCortexRuns[0]!} loadSteps={() => okAsync<StepExecutionRow[], DbError>(mockRunSteps)} onClose={noop} />
                    </DialogShowcase>
                </State>
                <State n="18" label="sidebar RUNS progress embed — bounded step window, no heading">
                    {/* The sidebar RUNS section renders the newest non-terminal run's progress under
                        that run's own row: heading suppressed (the row above names the run), the same
                        frontier-positioned step window (the rail step cap, hint=false) the section passes, while
                        the bar and done/total reflect the full run. The elision markers above and below
                        the window name the hidden counts, so the rows on screen always reconcile against
                        done/total — and each one is a click target that slides the window a step its way.
                        Driven from the long-run fixture. */}
                    <text fg={theme().fgMuted}>
                        under the newest run row in the sidebar while it is non-terminal; long runs window their steps behind counted elision markers — click
                        one to slide the window a step (rail step cap, heading off):
                    </text>
                    <RunBlock
                        name={mockLongRun.name}
                        tag={mockLongRun.tag}
                        done={mockLongRun.done}
                        total={mockLongRun.total}
                        steps={longRunSteps}
                        maxSteps={size.railStepRows}
                        hint={false}
                        heading={false}
                    />
                </State>
                <State n="19" label="inline presentation — text-shaped show_user (markdown / code / table)">
                    {/* Text-shaped `show_user` content rendered inline through the <markdown> renderable. */}
                    <PresentationBlock
                        title="Key finding"
                        body={{ kind: "markdown", body: "**TP53** is significantly upregulated (log2FC 2.4, _padj_ 3e-8)." }}
                    />
                    <PresentationBlock title="Normalization snippet" body={{ kind: "code", code: "dds <- DESeq(dds)\nres <- results(dds)", language: "r" }} />
                    <PresentationBlock
                        title="Top DE genes"
                        body={{
                            kind: "table",
                            headers: ["gene", "log2FC", "padj"],
                            rows: [
                                ["TP53", "2.4", "3e-8"],
                                ["MYC", "-1.8", "1e-5"],
                            ],
                            caption: "differential expression, condition A vs B",
                        }}
                    />
                </State>
                <State n="20" label="openable card — pixel-shaped content (chart / gallery + folder / missing / failed)">
                    {/* Pixel-shaped content a terminal can't paint: click a row to open it externally.
                        onOpen is inert here — the gallery renders the pure block with resolved fixtures. */}
                    <OpenableCardBlock
                        title="Differential expression"
                        rows={[{ name: "Volcano plot", path: "~/proj/.inflexa/analyses/rna/presentations/pres-9f21a3.html", degraded: false }]}
                        onOpen={noop}
                    />
                    <OpenableCardBlock
                        title="Figures"
                        rows={[
                            {
                                name: "volcano.png",
                                caption: "condition A vs B",
                                path: "~/proj/.inflexa/analyses/rna/runs/run-abc/figures/volcano.png",
                                degraded: false,
                            },
                            {
                                name: "heatmap.png",
                                caption: "top 50 DE genes",
                                path: "~/proj/.inflexa/analyses/rna/runs/run-abc/figures/heatmap.png",
                                degraded: false,
                            },
                        ]}
                        folderLabel="Open containing folder"
                        onOpen={noop}
                        onOpenFolder={noop}
                    />
                    <OpenableCardBlock
                        title="Referenced file"
                        rows={[
                            {
                                name: "de-summary.csv",
                                path: "~/proj/.inflexa/analyses/rna/runs/run-abc/output/de-summary.csv",
                                degraded: true,
                            },
                        ]}
                        onOpen={noop}
                    />
                    <OpenableCardBlock
                        rows={[{ name: "Report preview v2 failed", caption: "render timed out after 60s", path: null, degraded: true }]}
                        onOpen={noop}
                    />
                </State>
                <State n="21" label="approval prompt & ask cards — docked ctx.ask surface + reconciled transcript cards">
                    {/* The docked AskPrompt as it sits above the chat bar, rendered inert. No onFocusReady
                        handle is passed, so no host ever focuses the box: its y/a/n KEY layer is gated on
                        that box's own focus target (and on MODE_BASE, suspended under this dialog), so it can
                        never win the keymap or swallow a keystroke from the gallery pane. But a CLICK on a
                        choice option needs no focus, so the focus gate alone would let a gallery click flip
                        an exhibit into feedback mode and let its auto-focusing input steal the pane's focus —
                        so every exhibit passes `inert`, which no-ops the option clicks (and, on the feedback
                        exhibit, also mounts its embedded input blurred). Callbacks are no-ops; the feedback
                        surface is seeded directly via initialMode below. */}
                    <text fg={theme().fgMuted}>choice mode — title + command, bare y/a/n keys (focus-gated, inert here):</text>
                    <AskPrompt
                        title={mockAskPrompts.basic.title}
                        command={mockAskPrompts.basic.command}
                        queuedCount={mockAskPrompts.basic.queuedCount}
                        inert
                        onApprove={noop}
                        onReject={noop}
                    />
                    <text fg={theme().fgMuted}>with detail — a secondary context line under the command:</text>
                    <AskPrompt
                        title={mockAskPrompts.withDetail.title}
                        command={mockAskPrompts.withDetail.command}
                        detail={mockAskPrompts.withDetail.detail}
                        queuedCount={mockAskPrompts.withDetail.queuedCount}
                        inert
                        onApprove={noop}
                        onReject={noop}
                    />
                    <text fg={theme().fgMuted}>stacked queue — the `+N more` hint when asks wait behind the head:</text>
                    <AskPrompt
                        title={mockAskPrompts.queued.title}
                        command={mockAskPrompts.queued.command}
                        queuedCount={mockAskPrompts.queued.queuedCount}
                        inert
                        onApprove={noop}
                        onReject={noop}
                    />
                    <text fg={theme().fgMuted}>feedback mode — reject opens an optional feedback input (seeded via initialMode, inert here):</text>
                    <AskPrompt
                        title={mockAskPrompts.basic.title}
                        command={mockAskPrompts.basic.command}
                        queuedCount={mockAskPrompts.basic.queuedCount}
                        initialMode="feedback"
                        inert
                        onApprove={noop}
                        onReject={noop}
                    />
                    <text fg={theme().fgMuted}>transcript ask cards — pending then each terminal status (reconciled in place by ask id):</text>
                    <MessageBlock index={1} role="assistant" parts={mockAskCards} streamPartId={noStreamId} streamText={noStreamText} />
                </State>
                <State n="22" label="interrupt affordance — interrupted marker + footer hint (NORMAL / armed / INSERT)">
                    <text fg={theme().fgMuted}>interrupted assistant turn — a muted "interrupted" marker follows the meta on the header row:</text>
                    <MessageBlock index={1} role="user" parts={[mockUserText]} streamPartId={noStreamId} streamText={noStreamText} />
                    <MessageBlock
                        index={2}
                        role="assistant"
                        durationMs={1830}
                        interrupted
                        parts={[mockAssistantText]}
                        streamPartId={noStreamId}
                        streamText={noStreamText}
                    />
                    {/* The footer hint sits after the mode word it describes. autoFocus={false} mounts the
                        NORMAL exhibits blurred so they never take the gallery pane's focus; the INSERT
                        exhibit seeds INSERT the same way, its seed being decoupled from a real focus-grab
                        (see ChatBar.autoFocus). onTextareaRef/onSubmit are inert — the exhibits are static. */}
                    <text fg={theme().fgMuted}>footer hint — busy NORMAL, unarmed (the muted resting esc form, after the mode word):</text>
                    <ChatBar
                        autoFocus={false}
                        onTextareaRef={noop}
                        onSubmit={noop}
                        interruptHint={{ label: interruptHintLabel(interruptKey, false), armed: false }}
                    />
                    <text fg={theme().fgMuted}>footer hint — busy NORMAL, armed (the "again to interrupt" confirm form in the warn treatment):</text>
                    <ChatBar
                        autoFocus={false}
                        onTextareaRef={noop}
                        onSubmit={noop}
                        interruptHint={{ label: interruptHintLabel(interruptKey, true), armed: true }}
                    />
                    <text fg={theme().fgMuted}>footer hint — busy INSERT, advertising the one-press abort chord that interrupts while typing:</text>
                    <ChatBar autoFocus onTextareaRef={noop} onSubmit={noop} interruptHint={{ label: interruptHintLabel(abortKey, false), armed: false }} />
                </State>
                <State n="23" label="run-activity panel — frontier readout between the stream and the input">
                    {/* The panel answers "what is happening right now" for ONE focused run; the sidebar
                        RUNS section answers "what is the shape of the work". The only overlap is the
                        completion count — bare text here, a meter there — so the two never read as the
                        same widget shown twice. The key labels are passed literally in these exhibits;
                        the real mount derives them from the bindings via keybindLabel.

                        Every exhibit below is wrapped in a `bg`-painted column because the gallery's own
                        panel is `bgRaised` — the same surface the activity panel paints. Rendered directly
                        into the gallery the tint would have nothing to separate from, so the exhibit
                        would misrepresent the design in the one place it is meant to be reviewed.

                        Activity strings here are the harness's own vocabulary (`activityForTool`), which
                        is what the live panel now shows — not a label derived from a workflow step name.

                        The legend carries the region: its name, which of the active runs is on screen,
                        and the chords that act on the panel. None of those is a fact about the run, so
                        no content row holds them. It degrades by width — opentui drops a border title
                        that does not fit rather than truncating it — so a narrow exhibit here sheds its
                        chords and then its position, which is the real behaviour and not a defect. */}
                    <text fg={theme().fgMuted}>one active run — the frontier step with its agent and live activity label:</text>
                    <box width="100%" backgroundColor={theme().bg}>
                        <ActivityPanel
                            subject={runSubject()}
                            activity="Running script deseq2.R"
                            activeCount={1}
                            position={1}
                            nextKeyLabel={activityPanelNextKey}
                            dismissKeyLabel={activityPanelToggleKey}
                            onNext={noop}
                        />
                    </box>
                    <text fg={theme().fgMuted}>
                        several active runs — the legend gains the position and the cycling chord (the header row is click-to-advance):
                    </text>
                    <box width="100%" backgroundColor={theme().bg}>
                        <ActivityPanel
                            subject={runSubject()}
                            activity="Writing file counts_matrix.csv"
                            activeCount={3}
                            position={2}
                            nextKeyLabel={activityPanelNextKey}
                            dismissKeyLabel={activityPanelToggleKey}
                            onNext={noop}
                        />
                    </box>
                    <text fg={theme().fgMuted}>parallel frontier — a run genuinely running several steps at once shows all of them:</text>
                    <box width="100%" backgroundColor={theme().bg}>
                        <ActivityPanel
                            subject={runSubject({
                                steps: [
                                    { label: "align reads", state: "running", startedAt: null, agent: "bioinformatician" },
                                    { label: "call variants", state: "running", startedAt: null, agent: "geneticist" },
                                ],
                            })}
                            activeCount={1}
                            position={1}
                            nextKeyLabel={activityPanelNextKey}
                            dismissKeyLabel={activityPanelToggleKey}
                            onNext={noop}
                        />
                    </box>
                    <text fg={theme().fgMuted}>degraded — this run's step read blipped, so the last known frontier renders muted and marked:</text>
                    <box width="100%" backgroundColor={theme().bg}>
                        <ActivityPanel
                            subject={runSubject({ stale: true })}
                            activity="Running script deseq2.R"
                            activeCount={1}
                            position={1}
                            nextKeyLabel={activityPanelNextKey}
                            dismissKeyLabel={activityPanelToggleKey}
                            onNext={noop}
                        />
                    </box>
                    <text fg={theme().fgMuted}>
                        no activity label resolved — omitted, never substituted (a placeholder would claim knowledge the reader lacks):
                    </text>
                    <box width="100%" backgroundColor={theme().bg}>
                        <ActivityPanel
                            subject={runSubject()}
                            activity={null}
                            activeCount={1}
                            position={1}
                            nextKeyLabel={activityPanelNextKey}
                            dismissKeyLabel={activityPanelToggleKey}
                            onNext={noop}
                        />
                    </box>
                    <text fg={theme().fgMuted}>no active run — the panel contributes ZERO rows (nothing renders between this line and the next):</text>
                    <box width="100%" backgroundColor={theme().bg}>
                        <ActivityPanel
                            subject={undefined}
                            activeCount={0}
                            position={0}
                            nextKeyLabel={activityPanelNextKey}
                            dismissKeyLabel={activityPanelToggleKey}
                            onNext={noop}
                        />
                    </box>

                    {/* THE OTHER SUBJECT KIND. A data profile is the second thing this panel can show, and
                        it is shaped differently on purpose: no completion count and no frontier rows,
                        because a profile is one agent loop with no step decomposition. A synthesized `1/1`
                        was rejected — the panel's numbers are the ledger's, and an invented denominator is
                        worse than none.

                        Its marker is the pair the rail's running-profile line uses, so one piece of work
                        looks like itself on both surfaces. The legend's region name comes from the focused
                        subject, so it reads PROFILE here — and because `PROFILE` is four columns longer
                        than `RUN`, its full legend first fits at a wider panel. */}
                    <text fg={theme().fgMuted}>a running data profile — name, elapsed, and its live activity; no count and no step rows:</text>
                    <box width="100%" backgroundColor={theme().bg}>
                        <ActivityPanel
                            subject={profileSubject()}
                            activity="Running script profile.py"
                            activeCount={1}
                            position={1}
                            nextKeyLabel={activityPanelNextKey}
                            dismissKeyLabel={activityPanelToggleKey}
                            onNext={noop}
                        />
                    </box>
                    <text fg={theme().fgMuted}>
                        a profile beside a run — runs always sort first, so a parity profile triggered on chat open never takes the panel from a launched run
                        (this is position 2 of 2):
                    </text>
                    <box width="100%" backgroundColor={theme().bg}>
                        <ActivityPanel
                            subject={profileSubject()}
                            activity="Indexing input descriptions for search"
                            activeCount={2}
                            position={2}
                            nextKeyLabel={activityPanelNextKey}
                            dismissKeyLabel={activityPanelToggleKey}
                            onNext={noop}
                        />
                    </box>
                    <text fg={theme().fgMuted}>
                        degraded profile — the ledger read blipped, so the last known state renders muted and marked rather than vanishing:
                    </text>
                    <box width="100%" backgroundColor={theme().bg}>
                        <ActivityPanel
                            subject={profileSubject({ stale: true })}
                            activity="Running script profile.py"
                            activeCount={1}
                            position={1}
                            nextKeyLabel={activityPanelNextKey}
                            dismissKeyLabel={activityPanelToggleKey}
                            onNext={noop}
                        />
                    </box>
                    <text fg={theme().fgMuted}>
                        a profile whose workflow id is not recorded yet — no stream to subscribe to, so the activity line is omitted, not faked:
                    </text>
                    <box width="100%" backgroundColor={theme().bg}>
                        <ActivityPanel
                            subject={profileSubject({ workflowId: null })}
                            activity={null}
                            activeCount={1}
                            position={1}
                            nextKeyLabel={activityPanelNextKey}
                            dismissKeyLabel={activityPanelToggleKey}
                            onNext={noop}
                        />
                    </box>

                    {/* IN CONTEXT. The two relationships the whole chrome design turns on are relationships
                        to its NEIGHBOURS, so a panel shown alone cannot demonstrate either: the rule caps
                        the panel where the scrolling transcript stops, and exactly ONE rule — the
                        composer's own top border — sits between the panel and the input. A second rule
                        here would read as a rendering artifact rather than as structure. */}
                    <text fg={theme().fgMuted}>
                        in context — transcript above, composer below: the rule caps the stream, and only ONE rule meets the input:
                    </text>
                    <box width="100%" height={9} flexDirection="column" backgroundColor={theme().bg}>
                        <box flexGrow={1} minHeight={0} paddingLeft={space.sm}>
                            <text fg={theme().fg}>…the transcript scrolls above the panel and is capped by its rule.</text>
                        </box>
                        <ActivityPanel
                            subject={runSubject()}
                            activity="Running script deseq2.R"
                            activeCount={1}
                            position={1}
                            nextKeyLabel={activityPanelNextKey}
                            dismissKeyLabel={activityPanelToggleKey}
                            onNext={noop}
                        />
                        <ChatBar autoFocus={false} onTextareaRef={noop} onSubmit={noop} />
                    </box>

                    {/* STACKED WITH AN ASK. Both dock in the same slot and both paint `bgRaised`, so a run
                        whose tool needs approval puts two raised surfaces flush against each other. Each
                        half keeps its own marker and typography, which is what keeps it legible; the seam
                        between them is carried by those, not by a boundary. Exhibited rather than left to
                        be discovered — giving the ask its own matching top cap is a live option, and it is
                        a change to `ask_prompt.tsx`, so it is a deliberate decision rather than a default. */}
                    <text fg={theme().fgMuted}>stacked with a docked ask — two raised surfaces meet; markers, not a boundary, carry the seam:</text>
                    <box width="100%" backgroundColor={theme().bg}>
                        <ActivityPanel
                            subject={runSubject()}
                            activity="Running script deseq2.R"
                            activeCount={1}
                            position={1}
                            nextKeyLabel={activityPanelNextKey}
                            dismissKeyLabel={activityPanelToggleKey}
                            onNext={noop}
                        />
                        <AskPrompt
                            inert
                            title={mockAskPrompts.basic.title}
                            command={mockAskPrompts.basic.command}
                            queuedCount={0}
                            onApprove={noop}
                            onReject={noop}
                        />
                    </box>
                </State>
                <State n="24" label="run card lifecycle — launched / settled / unavailable, and the sub-agent activity line">
                    {/* A run card is the conversation's memory of a launch: never hidden, never removed,
                        and never an instrument. Signalling completion by making a widget vanish is the
                        defect this whole surface exists to remove — and live done/total is the rail's and
                        the run-activity panel's to render, so a running run's card looks exactly like the
                        launch record below until it settles. */}
                    <text fg={theme().fgMuted}>launch record — the card while its run is going, and for any card outside the read window:</text>
                    <RunCardBlock runId={mockRunCardIds.runId} title="Differential expression" stepCount={4} />
                    <text fg={theme().fgMuted}>settled, success — the launch record gains a compact outcome line:</text>
                    <RunCardBlock
                        runId={mockRunCardIds.runId}
                        title="Differential expression"
                        stepCount={4}
                        state={{ kind: "settled", status: "completed", durationMs: 150_000, error: null }}
                    />
                    <text fg={theme().fgMuted}>settled, failure — the reason rides the card, so scroll-back answers "why" without a lookup:</text>
                    <RunCardBlock
                        runId={mockRunCardIds.runId}
                        title="Differential expression"
                        stepCount={4}
                        state={{ kind: "settled", status: "failed", durationMs: 32_000, error: "step T1S2 blocked: no counts matrix in the workspace" }}
                    />
                    <text fg={theme().fgMuted}>unavailable — the recorded identity and an honest note, never a fabricated status:</text>
                    <RunCardBlock runId={mockRunCardIds.runId} title="Differential expression" stepCount={4} state={{ kind: "unavailable" }} />
                    <text fg={theme().fgMuted}>sub-agent activity — one subordinate line on a RUNNING tool call, gone the moment it finishes:</text>
                    <ToolBlock name="plan_analysis" status="running" activity="literature-reviewer: fetch_abstract" inlineStatus={true} />
                    <ToolBlock name="plan_analysis" status="ok" durationMs={94_000} activity="literature-reviewer: fetch_abstract" inlineStatus={true} />
                </State>
            </ScrollPane>
        </DialogPanel>
    );
}
