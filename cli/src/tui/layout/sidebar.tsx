import { createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { CortexRunRow } from "@inflexa-ai/harness";

import { theme } from "../theme.ts";
import { GLYPHS, size, space } from "../../lib/design_system.ts";
import type { ThemeColors } from "../../lib/design_system.ts";
import { Bold, Fg } from "../components/emphasis.tsx";
import { RunBlock } from "../components/run_block.tsx";
import { ScrollPane } from "../components/scroll_pane.tsx";
import {
    activeRunProgress,
    profileSnapshot,
    runsSnapshot,
    absTime,
    absTimeShort,
    relAge,
    runMark,
    idTail,
    RUN_STATUS_TERMINAL,
} from "../hooks/sidebar_live.ts";
import type { ActiveRunProgress } from "../hooks/sidebar_live.ts";
import { agentModels, bootState } from "../hooks/boot.ts";
import type { AgentName, ModelConnectionIdentity } from "../../modules/harness/config.ts";
import { getSession, getAnchor, listAnalysisInputs } from "../../db/primary_query.ts";
import { useWorkspace } from "../contexts/workspace.ts";
import { Bus } from "../../lib/bus.ts";
import type { StampedEvent } from "../../types/events.ts";
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
 * glyph, muted label). Keeping it a value the render maps over keeps the state ladder in one
 * exhaustive place rather than scattered across JSX branches.
 */
type LiveLine = { glyph: string | null; role: keyof ThemeColors; text: string };

/** First non-empty line of an error, clamped to the rail's one-line budget; a sane label when empty. */
function firstLine(error: string | null): string {
    const line = (error ?? "").split("\n", 1)[0]?.trim() ?? "";
    return line.length > 0 ? line : "failed";
}

/** Map a {@link ProfileSnapshot} to its display line: muted placeholders, warn "profiling…", success count+age, error one-liner. */
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
                    // Absolute local completed time (not a compact relative age): a finished profile is a
                    // durable record read long after "8h ago" lost its anchor, so the rail matches the
                    // details dialog. It may soft-wrap on long locales — acceptable in the fixed-width rail.
                    return { glyph: GLYPHS.check, role: "success", text: `${n} file${n === 1 ? "" : "s"} ${GLYPHS.middot} ${absTime(p.completedAt)}` };
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

/**
 * One MODELS-section row: an agent's currently-running model (an em dash until the runtime installs the
 * switch), and — when a switch is scheduled behind in-flight agent work — a warn-colored pending line
 * naming the model that will take effect once the work settles. Reads the live `agentModels` store
 * reactively, so a swap or a scheduled selection repaints without any wiring here.
 */
function AgentModelLine(props: { label: string; agent: AgentName }): JSX.Element {
    const current = (): string => agentModels().current[props.agent];
    const pending = (): string | undefined => agentModels().pending.get(props.agent);
    return (
        <>
            <text>
                <Fg role="fgMuted">{`${props.label} `}</Fg>
                <Fg role="fg">{current() || GLYPHS.emDash}</Fg>
            </text>
            <Show when={pending()} keyed>
                {(next: string) => (
                    <text>
                        <Fg role="warning">{`  ${GLYPHS.warning} ${GLYPHS.arrowRight} `}</Fg>
                        <Fg role="fgMuted">{`${next} (pending)`}</Fg>
                    </text>
                )}
            </Show>
        </>
    );
}

/**
 * The MODELS-section connection line: the shared connection's identity — the configured provider slug and
 * mode — rendered above the per-agent rows so the user sees which backend both agents run on. Reads the
 * immutable boot-ready state, NOT the swap-tracking `agentModels` store, because a live agent-model swap
 * never changes the connection — the connection is shared by both agents, so a swap changes only a model;
 * it is seeded once at the ready edge. Renders nothing before ready, when no identity exists yet.
 */
function ConnectionLine(): JSX.Element {
    const identity = (): ModelConnectionIdentity | null => {
        const boot = bootState();
        return boot.phase === "ready" ? boot.connection : null;
    };
    return (
        <Show when={identity()} keyed>
            {(c: ModelConnectionIdentity) => (
                <text>
                    <Fg role="fgMuted">{"conn "}</Fg>
                    <Fg role="accent">{c.provider}</Fg>
                    <Fg role="fgMuted">{` ${GLYPHS.middot} ${c.mode}`}</Fg>
                </text>
            )}
        </Show>
    );
}

// A single-line left border occupies exactly one terminal column; the rail draws one on its left edge.
const RAIL_BORDER_COLS = 1;

/**
 * A rail content row's usable width in terminal cells: the rail's fixed width less its left border
 * and its symmetric horizontal padding. opentui lays out on a character grid (one character = one
 * cell), so a header can merge its value onto the label row only when the label, a gap, and the
 * value together measure within this budget. Derived from the same tokens the rail box applies, so
 * the check can never drift from the real geometry.
 */
const RAIL_CONTENT_WIDTH = size.railWidth - RAIL_BORDER_COLS - space.sm * 2;

/**
 * Every character the {@link GLYPHS} registry can print, as single characters. The design system's
 * own contract is that each registry value occupies exactly ONE terminal cell — it bans emoji and
 * Nerd-Font glyphs precisely because the fixed-width TUI layout assumes one cell per glyph — so any
 * character in this set can be trusted as width 1, which a bare `.length` UTF-16 count cannot prove.
 * Built once here (flattening the multi-frame spinner value to its characters) so the fit check can
 * measure a value built from ASCII + registry glyphs (e.g. the SESSION handle `S·2f9a`) exactly.
 */
const SINGLE_CELL_GLYPHS: ReadonlySet<string> = new Set(
    Object.values(GLYPHS)
        .flat()
        .flatMap((s) => [...s]),
);

/**
 * A sidebar section: a bold muted LABEL over its content rows. When a `value` is supplied AND it
 * fits beside the label on one rail row — the label, a one-cell gap, and the value all within
 * {@link RAIL_CONTENT_WIDTH} — the header collapses to a single `LABEL … value` row (label keeps its
 * bold muted style; value right-aligned by a flexGrow spacer in the section's fg color). When it does
 * not fit, it renders exactly the stacked layout: the label row, then the value as its own full-width
 * line below — never truncated or squeezed into a right-hand cell. The remaining children follow in
 * either case, so a section only ever moves its value, never duplicates it.
 */
function Section(props: { label: string; value?: string; children: JSX.Element; onActivate?: () => void }) {
    // Read reactively so a later value change (session swap, analysis rename) re-decides the fit. The
    // one-cell gap is space.sm — the minimum separation so label and value never abut on a full row.
    const fitsOnLabelRow = (): boolean => {
        const value = props.value;
        if (value === undefined) return false;
        // `.length` counts UTF-16 units, which equal terminal cells only for characters we can vouch
        // are single-cell: printable ASCII, and the design-system GLYPHS (single-cell by the registry's
        // contract — see SINGLE_CELL_GLYPHS). So the SESSION handle `S·2f9a`, whose `·` is GLYPHS.middot,
        // measures reliably and may merge. Any OTHER non-ASCII character (a CJK glyph is one unit but two
        // cells, an emoji several units for one-or-two) has a cell width we cannot cheaply trust — rather
        // than embed a wcwidth table, take the safe path and stack the whole value on its own full line,
        // where the width is never guessed wrong. The label is always an ASCII section name.
        const chars = [...value];
        for (const ch of chars) {
            if (!/[\x20-\x7e]/.test(ch) && !SINGLE_CELL_GLYPHS.has(ch)) return false;
        }
        return props.label.length + space.sm + chars.length <= RAIL_CONTENT_WIDTH;
    };
    // The arrow reads `props.onActivate` at click time (reactive-safe, and the section activation is
    // inert on the sections that pass none — only DATA PROFILE / RUNS supply a callback).
    return (
        <box flexDirection="column" paddingTop={1} onMouseUp={() => props.onActivate?.()}>
            <Show
                when={fitsOnLabelRow()}
                fallback={
                    <>
                        <text fg={theme().fgMuted}>
                            <Bold>{props.label}</Bold>
                        </text>
                        <Show when={props.value} keyed>
                            {(value: string) => <text fg={theme().fg}>{value}</text>}
                        </Show>
                    </>
                }
            >
                <box flexDirection="row">
                    <text fg={theme().fgMuted}>
                        <Bold>{props.label}</Bold>
                    </text>
                    {/* Spacer pushes the value to the rail's right edge — the StatusBar/ChatBar idiom. */}
                    <box flexGrow={1} />
                    <text fg={theme().fg}>{props.value}</text>
                </box>
            </Show>
            {props.children}
        </box>
    );
}

/**
 * The toggleable sidebar (full-height; spans the main row beside both the stream and the input).
 * Fixed width (`size.railWidth`), NOT mouse-resizable. Four sections in fixed order — SESSION,
 * ANALYSIS, DATA PROFILE, RUNS — following the pipeline: the analysis's inputs feed the DATA PROFILE,
 * and the profile feeds the RUNS. SESSION and ANALYSIS render live SQLite-backed data; DATA PROFILE and
 * RUNS render live harness-ledger data from the `sidebar_live` store (its snapshots degrade gracefully
 * before boot / on a read failure). Nothing here is mock. There is deliberately no CONTEXT/token-cost
 * section — no real accounting source exists to render.
 * Reads the pure `getAnchor` (NOT `resolveAnchor`, which writes a sighting heartbeat), so
 * rendering the sidebar never touches disk — the no-litter rule for passive flows.
 */
export function Sidebar(props: SidebarProps) {
    const ws = useWorkspace();
    // The wide-layout flip: at/above the breakpoint the ANALYSIS path line yields to the badge moving
    // onto the meta line. Reads the SAME `size.breakpointWide` token the status bar gates its path on,
    // so both surfaces flip together and the working-directory path shows on exactly one of them.
    const dims = useTerminalDimensions();
    const isWide = (): boolean => dims().width >= size.breakpointWide;
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
    // The anchor-marker health badge (marker written vs missing), or "" when no anchor exists. Muted
    // to match the surrounding meta text — it flags marker health quietly, without a status color.
    // Below the breakpoint it prefixes the path line; at/above it, the path line is dropped and this
    // prefixes the meta line instead, so the signal stays visible in exactly one spot at any width.
    const markerBadge = (): string => {
        const a = anchor();
        return a ? (a.markerWritten ? GLYPHS.check : GLYPHS.warning) : "";
    };
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
        // ≤3 rows — the rail carries the summary (plus the newest run's progress embed below its
        // row); the runs picker → detail dialogs carry the depth.
        return s.kind === "loaded" ? s.runs.slice(0, 3) : [];
    });

    // The agent models are present exactly once the runtime installs the live switch at boot (both agents
    // seed together), so an empty pair reads as "not ready" — decoupled from the boot phase so the
    // section reflects the switch's own authority, not a second boot-phase read.
    const modelsReady = createMemo((): boolean => {
        const c = agentModels().current;
        return c.conversation !== "" || c.sandbox !== "";
    });

    return (
        <box
            width={size.railWidth}
            flexShrink={0}
            flexDirection="column"
            paddingLeft={space.sm}
            paddingRight={space.sm}
            border={["left"]}
            borderColor={theme().border}
            backgroundColor={theme().bgRaised}
        >
            {/* The section stack scrolls when it outgrows the rail (the RUNS progress embed makes
                its height variable) instead of clipping or squeezing sections. Never focused —
                mouse-wheel only, so the pane's key layer stays disengaged and the rail steals no
                keys from the chat. Nothing sits below the pane, so the scrollbox 1-cell bleed
                (see cli/CLAUDE.md Layout) has no chrome row to bleed into. */}
            <ScrollPane focusOnMount={false} flexGrow={1} minHeight={0} width="100%">
                <Section label="SESSION" value={shortId(ws.sessionId)}>
                    <Show when={session()} keyed>
                        {(s: Session) => (
                            <text fg={theme().fgMuted}>
                                {Date.relativeAge(s.createdAt)} {GLYPHS.middot} {props.messageCount()} msgs
                            </text>
                        )}
                    </Show>
                </Section>

                <Section label="ANALYSIS" value={ws.analysis?.name}>
                    {/* The name rides the label row (or stacks under it, both via Section); only the
                    no-analysis fallback needs its own line here, since Section renders nothing when
                    the value is undefined. */}
                    <Show when={!ws.analysis}>
                        <text fg={theme().fgMuted}>no analysis</text>
                    </Show>
                    {/* Below the breakpoint the marker badge sits on its own line beside the resolved path. */}
                    <Show when={!isWide() && anchor()} keyed>
                        {(a: Anchor) => (
                            <text fg={theme().fgMuted}>
                                {a.markerWritten ? GLYPHS.check : GLYPHS.warning} {a.cachedPath}
                            </text>
                        )}
                    </Show>
                    {/* At/above the breakpoint the path line is dropped and the badge joins this meta line
                    (badge first, then the inputs/project text). */}
                    <text fg={theme().fgMuted}>
                        {isWide() && markerBadge() ? `${markerBadge()} ` : ""}
                        {inputCount()} input{inputCount() === 1 ? "" : "s"}
                        {ws.project ? ` ${GLYPHS.middot} proj: ${ws.project.name}` : ""}
                    </text>
                </Section>

                <Section label="DATA PROFILE" onActivate={props.onOpenProfile}>
                    <text>
                        {profileLine().glyph !== null ? <Fg role={profileLine().role}>{`${profileLine().glyph} `}</Fg> : null}
                        <Fg role="fgMuted">{profileLine().text}</Fg>
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
                                    {(run, index) => {
                                        const m = runMark(run.status);
                                        // A finished run is a durable record, read long after "20h" meant anything —
                                        // pin its absolute finish time (terminal paths always stamp completedAt), in
                                        // the rail's compact form so name + anchor share the fixed-width row. Only a
                                        // still-live run keeps the relative age.
                                        const when = RUN_STATUS_TERMINAL[run.status] ? absTimeShort(run.completedAt) : relAge(run.startedAt);
                                        return (
                                            <>
                                                <text>
                                                    <Fg role={m.role}>{`${m.glyph} `}</Fg>
                                                    {/* The run's id tail, NOT shortRunName — the latter resolves to the
                                                    workflow name "executeAnalysis" for every run (identical on every row).
                                                    The id tail is the per-run distinguisher and fits the fixed-width rail;
                                                    the plan's human title (up to 80 chars) would overflow it, so the title
                                                    lives in the runs picker instead. */}
                                                    <Fg role="fgMuted">{`${idTail(run.runId)} ${GLYPHS.middot} ${when}`}</Fg>
                                                </text>
                                                {/* The newest run's live progress, directly under its row. The refresh
                                                loop clears the snapshot whenever the newest run is terminal, so this
                                                can never show one run's progress under another's row. NON-keyed Show:
                                                each ~5s poll mints a fresh snapshot object, and keyed would tear down
                                                and remount the RunBlock every tick — non-keyed updates props in place.
                                                heading off: the run row above IS the heading. */}
                                                <Show when={index() === 0 ? activeRunProgress() : null}>
                                                    {(progress: Accessor<ActiveRunProgress>) => (
                                                        <RunBlock
                                                            name={progress().name}
                                                            tag={progress().tag}
                                                            done={progress().done}
                                                            total={progress().total}
                                                            steps={progress().steps}
                                                            maxSteps={7}
                                                            hint={false}
                                                            heading={false}
                                                        />
                                                    )}
                                                </Show>
                                            </>
                                        );
                                    }}
                                </For>
                            </Show>
                        </Match>
                    </Switch>
                </Section>

                <Section label="MODELS">
                    <Show when={modelsReady()} fallback={<text fg={theme().fgMuted}>runtime not ready</text>}>
                        <ConnectionLine />
                        <AgentModelLine label="chat" agent="conversation" />
                        <AgentModelLine label="sandbox" agent="sandbox" />
                    </Show>
                </Section>
            </ScrollPane>
        </box>
    );
}
