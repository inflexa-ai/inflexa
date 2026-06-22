import { createMemo, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";

import { theme } from "../theme.ts";
import { GLYPHS } from "../../lib/glyphs.ts";
import { getSession, getAnchor, listAnalysisInputs, findProjectByRef } from "../../db/primary_query.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { Session } from "../../types/session.ts";
import type { Anchor } from "../../types/anchor.ts";

// Comparable to opencode's fixed-width sidebar.
const SIDEBAR_WIDTH = 40;

/** Props for {@link Sidebar}. Accessors so an in-place analysis/session swap repaints the sidebar. */
export type SidebarProps = {
    /** The open analysis. */
    analysis: Accessor<Analysis>;
    /** The open session id. */
    sessionId: Accessor<string>;
    /** Live message count (the chat's message-store length). */
    messageCount: Accessor<number>;
};

function relativeAge(createdAt: number): string {
    const secs = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

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
    const session = createMemo(() =>
        getSession(props.sessionId()).match(
            (s) => s,
            () => null,
        ),
    );
    const anchor = createMemo(() =>
        getAnchor(props.analysis().anchorId).match(
            (a) => a,
            () => null,
        ),
    );
    const inputCount = createMemo(() =>
        listAnalysisInputs(props.analysis().id).match(
            (xs) => xs.length,
            () => 0,
        ),
    );
    const project = createMemo(() => {
        const pid = props.analysis().projectId;
        if (!pid) return null;
        return findProjectByRef(pid).match(
            (p) => p,
            () => null,
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
                <text fg={theme().fg}>{shortId(props.sessionId())}</text>
                <Show when={session()} keyed>
                    {(s: Session) => (
                        <text fg={theme().muted}>
                            {relativeAge(s.createdAt)} {GLYPHS.middot} {props.messageCount()} msgs
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
                <text fg={theme().fg}>{props.analysis().name}</text>
                <Show when={anchor()} keyed>
                    {(a: Anchor) => (
                        <text fg={theme().muted}>
                            {a.markerWritten ? GLYPHS.check : GLYPHS.warning} {a.cachedPath}
                        </text>
                    )}
                </Show>
                <text fg={theme().muted}>
                    {inputCount()} input{inputCount() === 1 ? "" : "s"}
                    {project() ? ` ${GLYPHS.middot} proj: ${project()!.name}` : ""}
                </text>
            </Section>

            {/* No run/task/step data model exists yet — explicit placeholder. */}
            <Section label="RUNS">
                <text fg={theme().muted}>no runs yet</text>
            </Section>
        </box>
    );
}
