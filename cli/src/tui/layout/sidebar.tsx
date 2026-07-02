import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";

import { theme } from "../theme.ts";
import { GLYPHS, size } from "../../lib/design_system.ts";
import { Bold, Fg } from "../components/emphasis.tsx";
import { mockContext, mockRuns } from "../../lib/mock_fixtures.ts";
import { getSession, getAnchor, listAnalysisInputs } from "../../db/primary_query.ts";
import { useWorkspace } from "../contexts/workspace.ts";
import { Bus } from "../../lib/bus.ts";
import type { StampedEvent } from "../../types/events.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { Session } from "../../types/session.ts";
import type { Anchor } from "../../types/anchor.ts";

/** Props for {@link Sidebar}. Only the live message count is passed; analysis/session/project come from the workspace store, which repaints the sidebar on an in-place swap. */
export type SidebarProps = {
    /** Live message count (the chat's message-store length). */
    messageCount: Accessor<number>;
};

// Short session handle, per the wireframe ("S·2f9a").
function shortId(id: string): string {
    return `S${GLYPHS.middot}${id.replace(/-/g, "").slice(0, 4)}`;
}

function Section(props: { label: string; children: JSX.Element }) {
    return (
        <box flexDirection="column" paddingTop={1}>
            <text fg={theme().fgMuted}>
                <Bold>{props.label}</Bold>
            </text>
            {props.children}
        </box>
    );
}

/**
 * The toggleable sidebar (full-height; spans the main row beside both the stream and the input).
 * Fixed width (`size.railWidth`), NOT mouse-resizable. SESSION and ANALYSIS render live data;
 * CONTEXT and RUNS render MOCK fixtures (see `mock_fixtures`) — sample data, identifiable as mock,
 * never live telemetry, and not wired to the conversation store.
 * Reads the pure `getAnchor` (NOT `resolveAnchor`, which writes a sighting heartbeat), so
 * rendering the sidebar never touches disk — the no-litter rule for passive flows.
 */
export function Sidebar(props: SidebarProps) {
    const ws = useWorkspace();
    const session = createMemo(() =>
        getSession(ws.sessionId).match(
            (s) => s,
            () => null,
        ),
    );
    // anchor/inputCount null-guard the (currently unreachable) null analysis; the render also wraps
    // the analysis name in <Show when={ws.analysis}>. The linked project now lives in the workspace
    // store (resolved once per openSession swap), so the sidebar no longer derives it here.
    const anchor = createMemo(() => {
        const a = ws.analysis;
        if (!a) return null;
        return getAnchor(a.anchorId).match(
            (x) => x,
            () => null,
        );
    });
    // The input count is a DB read with no reactive dependency of its own, so input-change bus
    // events tick a version signal the memo reads — the picker (and any future writer) updates
    // the sidebar live without a session swap. Filtered to THIS analysis: provenance events for
    // other analyses must not trigger re-reads.
    const [inputsVersion, setInputsVersion] = createSignal(0);
    const onInputEvent = (e: StampedEvent): void => {
        if (e.type !== "prov.input_added" && e.type !== "prov.input_removed") return;
        if (ws.analysis?.id !== e.analysisId) return;
        setInputsVersion((v) => v + 1);
    };
    Bus.on("inflexa", onInputEvent);
    onCleanup(() => Bus.off("inflexa", onInputEvent));

    const inputCount = createMemo(() => {
        inputsVersion();
        const a = ws.analysis;
        if (!a) return 0;
        return listAnalysisInputs(a.id).match(
            (xs) => xs.length,
            () => 0,
        );
    });

    return (
        <box
            width={size.railWidth}
            flexShrink={0}
            flexDirection="column"
            paddingLeft={1}
            paddingRight={1}
            border={["left"]}
            borderColor={theme().border}
            backgroundColor={theme().bgRaised}
        >
            <Section label="SESSION">
                <text fg={theme().fg}>{shortId(ws.sessionId)}</text>
                <Show when={session()} keyed>
                    {(s: Session) => (
                        <text fg={theme().fgMuted}>
                            {Date.relativeAge(s.createdAt)} {GLYPHS.middot} {props.messageCount()} msgs
                        </text>
                    )}
                </Show>
            </Section>

            {/* MOCK accounting (see mock_fixtures) — sample data, not live telemetry. */}
            <Section label="CONTEXT">
                <text fg={theme().fgMuted}>
                    {(mockContext.tokens / 1000).toFixed(1)}K tok {GLYPHS.middot} {mockContext.percent}% {GLYPHS.middot} ${mockContext.costUsd.toFixed(2)}
                </text>
            </Section>

            <Section label="ANALYSIS">
                <Show when={ws.analysis} keyed fallback={<text fg={theme().fgMuted}>no analysis</text>}>
                    {(a: Analysis) => <text fg={theme().fg}>{a.name}</text>}
                </Show>
                <Show when={anchor()} keyed>
                    {(a: Anchor) => (
                        <text fg={theme().fgMuted}>
                            {a.markerWritten ? GLYPHS.check : GLYPHS.warning} {a.cachedPath}
                        </text>
                    )}
                </Show>
                <text fg={theme().fgMuted}>
                    {inputCount()} input{inputCount() === 1 ? "" : "s"}
                    {ws.project ? ` ${GLYPHS.middot} proj: ${ws.project.name}` : ""}
                </text>
            </Section>

            {/* MOCK run rows (see mock_fixtures) — sample data, not live runs. */}
            <Section label="RUNS">
                <For each={mockRuns}>
                    {(run) => (
                        <text>
                            <Fg role={run.status === "done" ? "success" : "warning"}>{run.status === "done" ? GLYPHS.check : GLYPHS.circle}</Fg>{" "}
                            <Fg role="fgMuted">{`${run.tag} ${run.name}`}</Fg>
                        </text>
                    )}
                </For>
            </Section>
        </box>
    );
}
