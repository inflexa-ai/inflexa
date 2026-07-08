import type { JSX } from "solid-js";
import { TextareaRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { okAsync } from "neverthrow";
import type { DbError, StepExecutionRow } from "@inflexa-ai/harness";

import { GLYPHS, space } from "../../lib/design_system.ts";
import { theme } from "../theme.ts";
import { KEYS, chordLabel } from "../keymap.ts";
import { useDialogBindings, useDialogCancel, useDialogEntry, DialogShowcase } from "../components/dialog/dialog_host.tsx";
import { DialogPanel } from "../components/dialog/dialog_panel.tsx";
import { PromptDialog } from "../components/dialog/prompt_dialog.tsx";
import { ConfirmDialog } from "../components/dialog/confirm_dialog.tsx";
import { AlertDialog } from "../components/dialog/alert_dialog.tsx";
import { ResultsDialog } from "../components/dialog/results_dialog.tsx";
import { ExportOptionsDialog } from "../components/dialog/export_options_dialog.tsx";
import { Welcome } from "../components/welcome.tsx";
import { ThinkingBlock } from "../components/thinking_block.tsx";
import { ThinkingIndicator } from "../components/thinking_indicator.tsx";
import { BootIndicator } from "../components/boot_indicator.tsx";
import { ToolBlock } from "../components/tool_block.tsx";
import { DiffBlock } from "../components/diff_block.tsx";
import { RunBlock } from "../components/run_block.tsx";
import { ErrorBlock } from "../components/error_block.tsx";
import { MessageBlock } from "./message_block.tsx";
import { Bold, Italic, Underline, Dim, Reverse, Fg } from "../components/emphasis.tsx";
import { TextArea } from "../components/text_area.tsx";
import { TextInput } from "../components/text_input.tsx";
import { ScrollPane } from "../components/scroll_pane.tsx";
import { FixedList } from "../components/fixed_list.tsx";
import { SelectDialog } from "../components/dialog/select_dialog.tsx";
import { FilePicker } from "../components/dialog/file_picker.tsx";
import { RunsDialog } from "../components/dialog/runs_dialog.tsx";
import {
    mockUserText,
    mockAssistantText,
    mockThinking,
    mockToolCall,
    mockFileEdit,
    mockRun,
    mockPlanCard,
    mockRunCard,
    mockCortexRuns,
    mockRunSteps,
} from "../../lib/mock_fixtures.ts";

// Nothing streams in the gallery — MessageBlock's streaming accessors are constant stubs.
const noStreamId = (): string | null => null;
const noStreamText = (): string => "";

const noop = (): void => {
    /* gallery showcase: submit is a no-op since inputs are non-interactive */
};

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
 * (see `mock_fixtures`). This is the spec's "render all eight states faithfully" surface: it drives
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
    const runSteps = mockRun.steps.map((s) => ({ label: s.label, state: s.state }));
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
                        target={mockToolCall.target}
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
                        <Bold>bold</Bold> <Fg role="fgMuted">— names, active items</Fg>
                    </text>
                    <text>
                        regular <Fg role="fgMuted">— body / assistant text</Fg>
                    </text>
                    <text>
                        <Dim>dim</Dim> <Fg role="fgMuted">— meta, labels, hints (color role preferred)</Fg>
                    </text>
                    <text>
                        <Italic>italic</Italic> <Fg role="fgMuted">— reasoning / quoted (terminal-dependent)</Fg>
                    </text>
                    <text>
                        <Underline>underline</Underline> <Fg role="fgMuted">— links / paths</Fg>
                    </text>
                    <text>
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
                <State n="15" label="live tool activity — running / done (with duration) / error">
                    {/* The harness emit adapter mints these from tool-started/tool-finished: no
                        result panel (live events carry no output), just name + outcome + timing. */}
                    <ToolBlock name="grep" target="src/**/*.ts" status="running" />
                    <ToolBlock name="read_file" target="src/db/types.ts :55-105" status="ok" durationMs={1240} />
                    <ToolBlock name="write_file" target="out/report.html" status="error" durationMs={320} />
                </State>
                <State n="16" label="harness cards — plan card & run card">
                    <MessageBlock index={1} role="assistant" parts={[mockPlanCard]} streamPartId={noStreamId} streamText={noStreamText} />
                    <MessageBlock index={2} role="assistant" parts={[mockRunCard]} streamPartId={noStreamId} streamText={noStreamText} />
                </State>
                <State n="17" label="sidebar details — data profile & runs (inert exhibits)">
                    {/* Profile details reuse ResultsDialog verbatim; these lines are what
                        `profileDetailLines` composes from a loaded profile snapshot. */}
                    <text fg={theme().fgMuted}>ResultsDialog — data-profile details (composed from a loaded profile snapshot):</text>
                    <DialogShowcase>
                        <ResultsDialog
                            title={`Data profile ${GLYPHS.emDash} rna-seq-2026`}
                            lines={[
                                "status: completed",
                                "started 5m",
                                "completed 4m",
                                "",
                                "12 samples across 2 conditions; counts pass QC with no dropped libraries.",
                                "",
                                "files (2):",
                                `  data/counts.tsv ${GLYPHS.emDash} gene-by-sample raw counts`,
                                `  data/meta.csv ${GLYPHS.emDash} sample metadata (condition, batch)`,
                                "",
                                "2 seed inputs",
                            ]}
                            emptyText="no profile data"
                            onClose={noop}
                        />
                    </DialogShowcase>
                    <text fg={theme().fgMuted}>RunsDialog — recent runs + the latest run's steps (done / running / failed / queued):</text>
                    <DialogShowcase>
                        <RunsDialog
                            title={`Runs ${GLYPHS.emDash} rna-seq-2026`}
                            runs={{ kind: "loaded", runs: mockCortexRuns }}
                            loadSteps={() => okAsync<StepExecutionRow[], DbError>(mockRunSteps)}
                            onClose={noop}
                        />
                    </DialogShowcase>
                </State>
            </ScrollPane>
        </DialogPanel>
    );
}
