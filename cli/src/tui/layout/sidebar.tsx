import { createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import type { CortexRunRow, RunStatus } from "@inflexa-ai/harness";

import { theme } from "../theme.ts";
import { GLYPHS, size } from "../../lib/design_system.ts";
import type { ThemeColors } from "../../lib/design_system.ts";
import { Bold, Fg } from "../components/emphasis.tsx";
import { profileSnapshot, runsSnapshot } from "../hooks/sidebar_live.ts";
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
    /** Open the data-profile details view (wired to the DATA PROFILE section's click + leader key). */
    onOpenProfile?: () => void;
    /** Open the runs details view (wired to the RUNS section's click + leader key). */
    onOpenRuns?: () => void;
};

// Short session handle, per the wireframe ("S·2f9a").
function shortId(id: string): string {
    return `S${GLYPHS.middot}${id.replace(/-/g, "").slice(0, 4)}`;
}

/**
 * The DATA PROFILE / RUNS line descriptor: an optional status-colored glyph (`null` for the muted
 * placeholder states) beside muted meta text, mirroring the RUNS row + `RunBlock` step shape (colored
 * glyph, muted label). Keeping it a value the render maps over keeps the D3/D4 state ladder in one
 * exhaustive place rather than scattered across JSX branches.
 */
type LiveLine = { glyph: string | null; role: keyof ThemeColors; text: string };

/** Relative age of an ISO timestamp, or an em dash when absent/unparseable — the sidebar never shows a raw date. */
function relAge(iso: string | null): string {
    if (iso === null) return GLYPHS.emDash;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? GLYPHS.emDash : Date.relativeAge(t);
}

/** First non-empty line of an error, clamped to the rail's one-line budget (design D3); a sane label when empty. */
function firstLine(error: string | null): string {
    const line = (error ?? "").split("\n", 1)[0]?.trim() ?? "";
    return line.length > 0 ? line : "failed";
}

/** Map a {@link ProfileSnapshot} to its D3 line: muted placeholders, warn "profiling…", success count+age, error one-liner. */
function profileLineOf(snap: ReturnType<typeof profileSnapshot>): LiveLine {
    switch (snap.kind) {
        case "not_ready":
            return { glyph: null, role: "fgMuted", text: "runtime not ready" };
        case "unavailable":
            return { glyph: null, role: "fgMuted", text: "unavailable" };
        case "absent":
            return { glyph: null, role: "fgMuted", text: "not profiled" };
        case "loaded": {
            const p = snap.profile;
            switch (p.status) {
                case "pending":
                case "running":
                    return { glyph: GLYPHS.warning, role: "warning", text: `profiling${GLYPHS.ellipsis}` };
                case "completed": {
                    const n = p.result?.files.length ?? 0;
                    return { glyph: GLYPHS.check, role: "success", text: `${n} file${n === 1 ? "" : "s"} ${GLYPHS.middot} ${relAge(p.completedAt)}` };
                }
                case "failed":
                    return { glyph: GLYPHS.cross, role: "error", text: firstLine(p.error) };
                default: {
                    const _exhaustive: never = p.status;
                    return { glyph: null, role: "fgMuted", text: String(_exhaustive) };
                }
            }
        }
        default: {
            const _exhaustive: never = snap;
            return { glyph: null, role: "fgMuted", text: String(_exhaustive) };
        }
    }
}

/** The themed glyph + color role for a run's status (design D4: running=warn, completed=success, failed/canceled=error, else muted). */
function runMark(status: RunStatus): { glyph: string; role: keyof ThemeColors } {
    switch (status) {
        case "running":
            return { glyph: GLYPHS.circleHalf, role: "warning" };
        case "completed":
            return { glyph: GLYPHS.check, role: "success" };
        case "failed":
        case "canceled":
            return { glyph: GLYPHS.cross, role: "error" };
        case "partial":
        case "suspended_insufficient_funds":
            return { glyph: GLYPHS.circle, role: "fgMuted" };
        default: {
            const _exhaustive: never = status;
            return { glyph: GLYPHS.circle, role: "fgMuted" };
        }
    }
}

/** A run's short label: the workflow name, else the plan id tail, else the run id tail (design D4). */
function shortRunName(run: CortexRunRow): string {
    if (run.workflowName.length > 0) return run.workflowName;
    const id = run.planId ?? run.runId;
    return id.replace(/-/g, "").slice(-6);
}

function Section(props: { label: string; children: JSX.Element; onActivate?: () => void }) {
    // The arrow reads `props.onActivate` at click time (reactive-safe, and the section activation is
    // inert on the sections that pass none — only DATA PROFILE / RUNS supply a callback, per D6).
    return (
        <box flexDirection="column" paddingTop={1} onMouseUp={() => props.onActivate?.()}>
            <text fg={theme().fgMuted}>
                <Bold>{props.label}</Bold>
            </text>
            {props.children}
        </box>
    );
}

/**
 * The toggleable sidebar (full-height; spans the main row beside both the stream and the input).
 * Fixed width (`size.railWidth`), NOT mouse-resizable. Four sections in fixed order — SESSION, DATA
 * PROFILE, ANALYSIS, RUNS. SESSION and ANALYSIS render live SQLite-backed data; DATA PROFILE and RUNS
 * render live harness-ledger data from the `sidebar_live` store (its snapshots degrade gracefully
 * before boot / on a read failure). Nothing here is mock — the CONTEXT/token-cost section was deleted
 * (no real accounting exists; design D1).
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

    // DATA PROFILE / RUNS live data comes from the module store (see `hooks/sidebar_live.ts`), which
    // `App` refreshes on lifecycle edges + a bounded poll. The sidebar only reads the snapshots.
    const profileLine = createMemo(() => profileLineOf(profileSnapshot()));
    const recentRuns = createMemo((): CortexRunRow[] => {
        const s = runsSnapshot();
        // ≤4 rows — the rail carries the summary; the details dialog carries the depth (design D4).
        return s.kind === "loaded" ? s.runs.slice(0, 4) : [];
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

            <Section label="DATA PROFILE" onActivate={props.onOpenProfile}>
                <text>
                    {profileLine().glyph !== null ? <Fg role={profileLine().role}>{`${profileLine().glyph} `}</Fg> : null}
                    <Fg role="fgMuted">{profileLine().text}</Fg>
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

            <Section label="RUNS" onActivate={props.onOpenRuns}>
                <Switch>
                    <Match when={runsSnapshot().kind === "not_ready"}>
                        <text fg={theme().fgMuted}>runtime not ready</text>
                    </Match>
                    <Match when={runsSnapshot().kind === "unavailable"}>
                        <text fg={theme().fgMuted}>unavailable</text>
                    </Match>
                    <Match when={runsSnapshot().kind === "loaded"}>
                        <Show when={recentRuns().length > 0} fallback={<text fg={theme().fgMuted}>no runs</text>}>
                            <For each={recentRuns()}>
                                {(run) => {
                                    const m = runMark(run.status);
                                    return (
                                        <text>
                                            <Fg role={m.role}>{`${m.glyph} `}</Fg>
                                            <Fg role="fgMuted">{`${shortRunName(run)} ${GLYPHS.middot} ${relAge(run.startedAt)}`}</Fg>
                                        </text>
                                    );
                                }}
                            </For>
                        </Show>
                    </Match>
                </Switch>
            </Section>
        </box>
    );
}
