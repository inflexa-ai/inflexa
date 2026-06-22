import { createMemo, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";

import { theme } from "../theme.ts";
import { GLYPHS } from "../../lib/glyphs.ts";
import { getSession, getAnchor, listAnalysisInputs } from "../../db/primary_query.ts";
import { useWorkspace } from "../contexts/workspace.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { Session } from "../../types/session.ts";
import type { Anchor } from "../../types/anchor.ts";

// Comparable to opencode's fixed-width sidebar.
const SIDEBAR_WIDTH = 40;

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
            <text fg={theme().muted} attributes={1}>
                {props.label}
            </text>
            {props.children}
        </box>
    );
}

/**
 * The toggleable sidebar (full-height; spans the main row beside both the stream and the input).
 * Fixed width, NOT mouse-resizable. SESSION and ANALYSIS render live data; CONTEXT and RUNS are
 * explicit placeholders because no token/cost or run data model exists yet — never fabricated.
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
    const inputCount = createMemo(() => {
        const a = ws.analysis;
        if (!a) return 0;
        return listAnalysisInputs(a.id).match(
            (xs) => xs.length,
            () => 0,
        );
    });

    return (
        <box
            width={SIDEBAR_WIDTH}
            flexShrink={0}
            flexDirection="column"
            paddingLeft={1}
            paddingRight={1}
            border={["left"]}
            borderColor={theme().border}
            backgroundColor={theme().bgPanel}
        >
            <Section label="SESSION">
                <text fg={theme().fg}>{shortId(ws.sessionId)}</text>
                <Show when={session()} keyed>
                    {(s: Session) => (
                        <text fg={theme().muted}>
                            {Date.relativeAge(s.createdAt)} {GLYPHS.middot} {props.messageCount()} msgs
                        </text>
                    )}
                </Show>
            </Section>

            {/* No token/cost accounting exists yet — explicit placeholder, never fabricated. */}
            <Section label="CONTEXT">
                <text fg={theme().muted}>
                    {GLYPHS.emDash} tokens {GLYPHS.middot} {GLYPHS.emDash} {GLYPHS.middot} {GLYPHS.emDash}
                </text>
            </Section>

            <Section label="ANALYSIS">
                <Show when={ws.analysis} keyed fallback={<text fg={theme().muted}>no analysis</text>}>
                    {(a: Analysis) => <text fg={theme().fg}>{a.name}</text>}
                </Show>
                <Show when={anchor()} keyed>
                    {(a: Anchor) => (
                        <text fg={theme().muted}>
                            {a.markerWritten ? GLYPHS.check : GLYPHS.warning} {a.cachedPath}
                        </text>
                    )}
                </Show>
                <text fg={theme().muted}>
                    {inputCount()} input{inputCount() === 1 ? "" : "s"}
                    {ws.project ? ` ${GLYPHS.middot} proj: ${ws.project.name}` : ""}
                </text>
            </Section>

            {/* No run/task/step data model exists yet — explicit placeholder. */}
            <Section label="RUNS">
                <text fg={theme().muted}>no runs yet</text>
            </Section>
        </box>
    );
}
