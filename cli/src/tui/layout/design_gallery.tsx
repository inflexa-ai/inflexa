import { onMount } from "solid-js";
import type { JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";

import { GLYPHS, space } from "../../lib/design_system.ts";
import { theme } from "../theme.ts";
import { useBindings, KEYS, chordLabel } from "../keymap.ts";
import { DialogPanel } from "../components/dialog/dialog_panel.tsx";
import { Welcome } from "../components/welcome.tsx";
import { ThinkingBlock } from "../components/thinking_block.tsx";
import { ThinkingIndicator } from "../components/thinking_indicator.tsx";
import { ToolBlock } from "../components/tool_block.tsx";
import { DiffBlock } from "../components/diff_block.tsx";
import { RunBlock } from "../components/run_block.tsx";
import { ErrorBlock } from "../components/error_block.tsx";
import { MessageBlock } from "./message_block.tsx";
import { Bold, Italic, Underline, Dim, Reverse, Fg } from "../components/emphasis.tsx";
import { TextArea } from "../components/text_area.tsx";
import { TextInput } from "../components/text_input.tsx";
import { mockUserText, mockAssistantText, mockThinking, mockToolCall, mockFileEdit, mockRun } from "../../lib/mock_fixtures.ts";

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
    let scrollRef: ScrollBoxRenderable | null = null;
    onMount(() => queueMicrotask(() => scrollRef?.focus()));
    useBindings(() => ({
        bindings: [
            { chord: KEYS.escape, run: () => props.onClose() },
            { chord: KEYS.q, run: () => props.onClose() },
        ],
    }));
    const runSteps = mockRun.steps.map((s) => ({ label: s.label, state: s.state }));
    return (
        <DialogPanel title="Design system — stream blocks" size="xl" footer={`${chordLabel(KEYS.escape)}/${chordLabel(KEYS.q)} close`}>
            <scrollbox
                ref={(r: ScrollBoxRenderable) => {
                    scrollRef = r;
                }}
                focused
                flexGrow={1}
                width="100%"
                paddingTop={space.sm}
            >
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
                <State n="9" label="TextArea — full / compact / bare chrome">
                    <text fg={theme().fgMuted}>click a textarea to see INSERT {GLYPHS.arrowRight} NORMAL mode shift</text>
                    <text fg={theme().fgMuted}>full (border signals focus, host adds footer):</text>
                    <TextArea chrome="full" placeholder="Type a message…" onSubmit={noop} />
                    <text fg={theme().fgMuted}>compact (mode word in border title):</text>
                    <TextArea chrome="compact" placeholder="Enter a name…" onSubmit={noop} />
                    <text fg={theme().fgMuted}>bare (background shift only):</text>
                    <TextArea chrome="bare" placeholder="Bare textarea…" onSubmit={noop} />
                </State>
                <State n="10" label="TextInput — compact / bare chrome">
                    <text fg={theme().fgMuted}>compact (bordered, focus shifts border):</text>
                    <TextInput chrome="compact" placeholder="Filter…" />
                    <text fg={theme().fgMuted}>bare (no border):</text>
                    <TextInput chrome="bare" placeholder="Type to filter…" />
                </State>
                <State n="11" label="type & emphasis">
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
            </scrollbox>
        </DialogPanel>
    );
}
