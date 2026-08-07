import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
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
import { libStoreGateState } from "../hooks/sandbox_gate.tsx";
import type { LibStoreGateState } from "../hooks/sandbox_gate.tsx";
import { chatStatus } from "../hooks/status.ts";
import type { ChatStatus } from "../hooks/status.ts";
import { openThread } from "../hooks/thread.ts";
import type { AgentName, ModelConnectionIdentity } from "../../modules/harness/config.ts";
import { getAnchor, getSessionUsageTotalsIncludingRuns, listAnalysisInputs } from "../../db/primary_query.ts";
import type { LlmUsageTotals } from "../../db/primary_query.ts";
import { formatTokenFigure, tokenFigureDetail } from "../../lib/usage_format.ts";
import type { TokenQuantities } from "../../lib/usage_format.ts";
import { TokenFigure } from "../components/token_figure.tsx";
import { Sep } from "../components/separator.tsx";
import { useWorkspace } from "../contexts/workspace.ts";
import { Bus } from "../../lib/bus.ts";
import type { StampedEvent } from "../../types/events.ts";
import type { Anchor } from "../../types/anchor.ts";
import type { Thread } from "@inflexa-ai/harness";

/** Props for {@link Sidebar}. Only the live message count is passed; analysis/session/project come from the workspace store, which repaints the sidebar on an in-place swap. */
export type SidebarProps = {
    /** Live message count (the chat's message-store length). */
    messageCount: Accessor<number>;
    /** Open the data-profile details view (wired to the DATA PROFILE section's click + leader key). */
    onOpenProfile?: () => void;
    /** Open the runs details view (wired to the RUNS section's click + leader key). */
    onOpenRuns?: () => void;
    /**
     * Open the usage breakdown dialog (wired to the USAGE section's click).
     *
     * Click only, deliberately: the section click is the affordance DATA PROFILE and RUNS already
     * teach, so a user who has learned it reaches for it here without being told. No chord is
     * reserved for it — an unused keybinding is a claim on the keymap that has to be paid for
     * whether or not anyone presses it, and one can be added later against the live map.
     */
    onOpenUsage?: () => void;
};

// Short session handle, per the wireframe ("S·2f9a"). Undefined while no thread is bound, so the
// Section renders its label alone rather than a handle over an id that does not exist yet.
function shortId(id: string | null): string | undefined {
    return id === null ? undefined : `S${GLYPHS.middot}${id.replace(/-/g, "").slice(0, 4)}`;
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

/**
 * Cell budget for the package-store transfer meter. The rail is `size.railWidth` wide and the meter
 * shares its row with nothing, so a fixed budget keeps the bar inside the slice at every terminal width.
 * The same figure the RUNS embed uses, for one reading of one notation across the rail.
 */
const STORE_BAR_CELLS = 20;

/**
 * The PACKAGES line for each state of the detached catalog download.
 *
 * Every state that is not a live transfer reads as one muted or status-colored line, exactly like the
 * DATA PROFILE row above it. A live transfer adds the meter, which is the one figure the sidebar owns —
 * the gate hold text carries none, because two surfaces must not show one figure.
 */
function storeLineOf(gate: LibStoreGateState): LiveLine {
    switch (gate.phase) {
        case "idle":
            return { glyph: null, role: "fgMuted", text: "not read yet" };
        case "absent":
            return { glyph: null, role: "fgMuted", text: "no download ran" };
        case "pending":
            return { glyph: GLYPHS.warning, role: "warning", text: `resolving the manifest${GLYPHS.ellipsis}` };
        case "downloading":
            // Before the manifest resolves there is no total, thus no meter and no ratio — the resolve step
            // is what the reader is told, and an estimate would be a number the CLI does not have.
            return {
                glyph: GLYPHS.warning,
                role: "warning",
                text: gate.totalBytes === null ? `resolving the manifest${GLYPHS.ellipsis}` : `${gate.bytes.formatBytes()} of ${gate.totalBytes.formatBytes()}`,
            };
        case "installed":
            return { glyph: GLYPHS.check, role: "success", text: gate.updateAvailable ? "installed — update available" : "installed" };
        case "failed":
            return { glyph: GLYPHS.cross, role: "error", text: firstLine(gate.message) };
        case "declined":
            return { glyph: GLYPHS.circleHollow, role: "fgSubtle", text: "declined at setup" };
        case "canceled":
            return { glyph: GLYPHS.circleHollow, role: "fgSubtle", text: "you stopped the transfer" };
        default: {
            const _exhaustive: never = gate;
            return { glyph: null, role: "fgMuted", text: String(_exhaustive) };
        }
    }
}

/**
 * The transfer meter, or `null` when there is nothing exact to draw.
 *
 * The same notation as the RUNS progress embed: `GLYPHS.bar` cells, the filled ones in `success` and the
 * empty ones in the `fgSubtle` decoration tier. A partly-done transfer is clamped to `[1, cells − 1]`, so
 * a transfer in flight never paints as fully filled or fully empty — an honest signal beats a rounding
 * artifact.
 */
function storeMeterOf(gate: LibStoreGateState): { filled: string; empty: string } | null {
    if (gate.phase !== "downloading" || gate.totalBytes === null || gate.totalBytes <= 0) return null;
    const proportional = Math.round((gate.bytes / gate.totalBytes) * STORE_BAR_CELLS);
    const partial = gate.bytes > 0 && gate.bytes < gate.totalBytes;
    const filled = partial ? Math.min(STORE_BAR_CELLS - 1, Math.max(1, proportional)) : Math.min(STORE_BAR_CELLS, Math.max(0, proportional));
    return { filled: GLYPHS.bar.repeat(filled), empty: GLYPHS.bar.repeat(STORE_BAR_CELLS - filled) };
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
 * The MODELS-section connection line: the configured provider slug, rendered above the per-agent rows
 * so the user sees which vendor all model roles run on. The connection MODE (`cliproxy`/`direct`) is
 * deliberately NOT here — it is transport plumbing, not a fact the user acts on from the rail, and the
 * fixed-width rail keeps the identity to one word; the full connection detail (mode included) lives in
 * the Status dialog. Reads the immutable boot-ready state, NOT the swap-tracking `agentModels` store,
 * because a live agent-model swap never changes the connection — the connection is shared by both
 * agents, so a swap changes only a model; it is seeded once at the ready edge. Renders nothing before
 * ready, when no identity exists yet.
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
                </text>
            )}
        </Show>
    );
}

// A single-line left border occupies exactly one terminal column; the rail draws one on its left edge.
/**
 * How many FINISHED runs the rail lists beneath the active ones. Active runs are never capped —
 * they are bounded by real concurrency and each is live work the reader needs to see — so this
 * bounds only the historical tail, which otherwise grows without limit. Three keeps the section
 * scannable; the runs picker carries the full history.
 */
const TERMINAL_RUN_ROWS = 3;

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
 * What the USAGE section renders: ONE muted message (every absence and every degrade), or the figure.
 *
 * A union rather than a widened row, because the cases carry genuinely different things and the tone
 * rule falls out of the tag: a message is always muted, so "nothing to report" can never read as a
 * measurement, while a figure is always data-toned. There is deliberately no case for "a figure plus a
 * note" — a section that could show both would let a caller pair a reported number with an absence
 * message and leave the reader to work out which one is the answer.
 *
 * ONE figure case, not the two ("all on one line" / "stacked when something nests") this section used
 * to carry. The two arms now ride the same row whether or not anything nests under them, so the row
 * count no longer depends on the data and there is nothing left for a second case to select.
 */
export type UsageSection = { kind: "message"; text: string } | { kind: "figure"; quantities: TokenQuantities };

/**
 * Map the open session's ledger totals to the USAGE section's render input.
 *
 * `calls` is what separates the two absences. No rows at all is a plain muted absence; rows whose
 * providers reported no figures say so instead, because "nothing was spent" is not a fact the ledger
 * holds and a zeroed figure would assert it.
 *
 * The LABELLED form throughout, per the section's own capability spec: consumption is what this
 * section is FOR — the only rail section whose entire subject is a number — so it is read
 * deliberately rather than scanned and can afford the words. The compact arrow form is reserved for
 * the figures DECORATING the DATA PROFILE and RUNS rows, where the subject is the entity and words
 * would crowd the name they annotate.
 *
 * Nothing here adds anything to anything. The cache counts are breakdowns OF input and the reasoning
 * count of output, so the figure NESTS them under the arm they are part of rather than listing them
 * beside it — levelling them is what would invite a reader to add a cached prefix to the total it is
 * already inside.
 *
 * Exported for its unit test: "this is the reported pair, never a sum" and "a call with no reported
 * quantities is not a zero" are claims about this mapping, and a character frame holding two numbers
 * cannot pin WHICH numbers they are.
 */
export function usageSectionOf(totals: LlmUsageTotals): UsageSection {
    if (totals.calls === 0) return { kind: "message", text: "no usage recorded" };
    const detail = tokenFigureDetail(totals);
    if (detail.input === null && detail.output === null) {
        return { kind: "message", text: `${totals.calls} call${totals.calls === 1 ? "" : "s"} ${GLYPHS.middot} no figures reported` };
    }
    return { kind: "figure", quantities: totals };
}

/**
 * The one-line figure a tracked entity — the data profile, a run row — carries beneath its own line,
 * or `null` when it carries none at all.
 *
 * Three states from two facts. A reported figure is data-toned. Calls recorded whose providers
 * reported no quantity is a muted em dash, the absence vocabulary the rail already uses for a time it
 * does not have — never a zero, which would claim the calls cost nothing. And an entity with no
 * ledger rows at all, or whose usage read failed, gets NOTHING: the RUNS section is not the place to
 * announce that a run predates the ledger, and a failed decoration must never remove the entity it
 * decorates.
 *
 * Exported for its unit test — the ladder is three tones and a character frame carries no color.
 */
export type EntityFigure = { role: keyof ThemeColors; text: string };

/** Map an entity's ledger totals (absent when the read failed) to its figure line — see {@link EntityFigure}. */
export function entityFigureOf(totals: LlmUsageTotals | undefined): EntityFigure | null {
    if (totals === undefined || totals.calls === 0) return null;
    const figure = formatTokenFigure(totals);
    return figure === "" ? { role: "fgMuted", text: GLYPHS.emDash } : { role: "fg", text: figure };
}

/**
 * An entity's figure, joining the facts its own row already carries rather than taking a line of its
 * own. Renders nothing when there is no figure, which keeps an ordinary run row exactly what it was.
 *
 * It had its own line, justified by a measurement that appending ~13 cells to a run row soft-wraps the
 * rail. The row wraps anyway: a plan title is a sentence, so the name alone already spans two or three
 * rail rows and the separate line was adding a further one rather than preventing a wrap. Inline, the
 * spend reads as one of the run's facts beside its age — which is where a reader looks for it — and
 * the section gets a row back.
 *
 * Spans, not a joined string: the figure's tone is the fact (`fg` reported, muted for an em dash) and
 * the separator's own tier is neither, so a single-role line could not paint all three.
 */
function EntityFigureSpan(props: { figure: EntityFigure | null }): JSX.Element {
    return (
        <Show when={props.figure} keyed>
            {(f: EntityFigure) => (
                <>
                    <Sep />
                    <Fg role={f.role}>{f.text}</Fg>
                </>
            )}
        </Show>
    );
}

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
    // inert on the sections that pass none — only DATA PROFILE / RUNS / USAGE supply a callback).
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
 * Fixed width (`size.railWidth`), NOT mouse-resizable. Six sections in fixed order — SESSION,
 * ANALYSIS, DATA PROFILE, RUNS, USAGE, MODELS. The first four follow the pipeline (the analysis's
 * inputs feed the DATA PROFILE, and the profile feeds the RUNS); USAGE then reports what all of that
 * work consumed, and MODELS closes with the models it ran on — the accounting reads after the work it
 * accounts for, and the configuration footer stays last.
 *
 * ANALYSIS and USAGE render live SQLite-backed data; SESSION, DATA PROFILE and RUNS render live
 * Postgres data from the `thread` / `sidebar_live` stores, and MODELS the boot store (each snapshot
 * degrades gracefully before boot / on a read failure). Nothing here is mock.
 *
 * Every section reports the entity it names, scoped to what is open: USAGE is the open SESSION's
 * consumption INCLUDING the runs that session launched — a chat turn that starts a run may itself
 * spend a few thousand tokens while the run spends hundreds of thousands, so a headline reporting the
 * former alone understates by orders of magnitude. That is a different reading from the session grain
 * `inflexa usage sessions` reports, which excludes runs so the grains still partition the analysis
 * total; the containment is visible rather than concealed because each run's own figure sits directly
 * above. The data profile is in NEITHER: its calls carry no thread, so its figures have exactly one
 * home, which is the DATA PROFILE section.
 *
 * USAGE reads the CLI's OWN local token ledger rather than anything behind the booted runtime, so it
 * neither gates on boot state nor arms a timer of its own: the figures are durable locally and
 * readable while the engine is cold. It refreshes on three edges this component already observes —
 * the chat status leaving `busy` (a turn actually completing), a `run.observed` bus event as a run
 * progresses, and `sidebar_live`'s bounded poll, which it rides by reading the snapshots that poll
 * republishes. It deliberately does NOT depend on the conversation's message count: the assistant
 * message is pushed when a turn STARTS, so a memo keyed on it reads the ledger before any of that
 * turn's calls were recorded, and past the store's message cap the push-and-shift leaves the length
 * unchanged and the memo never fires again.
 *
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
    // The bound thread's row, or null in every degraded kind — the SESSION section renders those as
    // muted placeholders rather than a title it does not have. The store (`hooks/thread.ts`) owns the
    // read; the rail only reads its snapshot, the same split as DATA PROFILE / RUNS.
    const thread = createMemo((): Thread | null => {
        const snap = openThread();
        return snap.kind === "loaded" ? snap.thread : null;
    });
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
    // The input count and the usage total are both DB reads with no reactive dependency of their own,
    // so bus events tick a version signal each memo reads — the picker (and any future writer) updates
    // the sidebar live without a session swap. ONE subscription serves both: a second Bus.on for a
    // second number would be two lifecycles to keep paired with one cleanup. Filtered to THIS analysis
    // first — every bus member is analysis-scoped, and another analysis's events must move neither
    // number.
    const [inputsVersion, setInputsVersion] = createSignal(0);
    const [usageVersion, setUsageVersion] = createSignal(0);
    const onSidebarEvent = (e: StampedEvent): void => {
        if (ws.analysis?.id !== e.analysisId) return;
        switch (e.type) {
            case "prov.input_added":
            case "prov.input_removed":
                setInputsVersion((v) => v + 1);
                break;
            // A TRIGGER only — the pushed run snapshot is never rendered, and carries no token figures
            // to render anyway. Re-reading the ledger keeps it the single source with one staleness
            // rule, the same discipline `hooks/sidebar_live.ts` applies to this event's other consumer.
            case "run.observed":
                setUsageVersion((v) => v + 1);
                break;
            // Every other provenance member is a chain fact neither number reads.
            default:
                break;
        }
    };
    Bus.on("inflexa", onSidebarEvent);
    onCleanup(() => Bus.off("inflexa", onSidebarEvent));

    // Turn completion, stated directly rather than inferred from a store's length: a turn's calls are
    // recorded inside the loop, so the moment the chat stops being busy the ledger already holds them.
    // The edge is "out of busy", not "busy → idle" — a turn that ends in `error` spent whatever it
    // spent before failing, and a figure that skipped those tokens would be wrong in exactly the
    // situation a user is most likely to go looking at it.
    //
    // `prev` is closure-local to this mount and seeded from the current status, so the effect's
    // initial synchronous run never fires a false edge. Mirrors `watchSidebarData`'s own trigger 2.
    let prevStatus: ChatStatus = chatStatus();
    createEffect(() => {
        const status = chatStatus();
        if (prevStatus === "busy" && status !== "busy") setUsageVersion((v) => v + 1);
        prevStatus = status;
    });

    const inputCount = createMemo(() => {
        inputsVersion();
        const a = ws.analysis;
        if (!a) return 0;
        return listAnalysisInputs(a.id).match(
            (xs) => xs.length,
            () => 0,
        );
    });

    // The open session's cumulative spend — the conversation's own calls AND every run it launched —
    // read synchronously from the local ledger on the same pattern the ANALYSIS section's reads use.
    // A SQLite aggregate needs neither the injected-seam indirection nor a poll of its own.
    //
    // Three triggers, none of them a clock this section owns: the version signal above (bumped on the
    // busy edge and on `run.observed`), and the two `sidebar_live` snapshots read below. A failed read
    // is a degraded row, never a thrown render: the rail keeps every other section.
    const usageSection = createMemo((): UsageSection => {
        usageVersion();
        // Read for the SUBSCRIPTION, not the value. `sidebar_live` republishes both snapshots as fresh
        // objects on every refresh it performs — including each tick of the bounded poll it already
        // arms while work is active and disarms when it is not — so reading them here puts this
        // section on exactly that cadence. A second interval would be a second thing to keep armed and
        // disarmed in step with the first, for a figure that is cumulative and whose lag understates.
        runsSnapshot();
        profileSnapshot();
        const a = ws.analysis;
        if (!a) return { kind: "message", text: "no analysis" };
        // A session identity cannot be resolved before boot, and the figure is a session's — so say
        // there is no session rather than silently widening to the analysis, which would report a
        // different question's answer under this section's label.
        const threadId = ws.sessionId;
        if (threadId === null) return { kind: "message", text: "no open session" };
        return getSessionUsageTotalsIncludingRuns(a.id, threadId).match(usageSectionOf, (): UsageSection => ({ kind: "message", text: "unavailable" }));
    });
    const usageQuantities = createMemo((): TokenQuantities | null => {
        const section = usageSection();
        return section.kind === "figure" ? section.quantities : null;
    });
    const usageMessage = createMemo((): string | null => {
        const section = usageSection();
        return section.kind === "message" ? section.text : null;
    });

    // The data profile's own figures, taken from the snapshot the live store already publishes rather
    // than read again here: the same totals feed the details dialog, whose composer is a pure
    // snapshot→lines function, so one read behind one generation guard serves both.
    const profileFigure = createMemo((): EntityFigure | null => {
        const snap = profileSnapshot();
        return entityFigureOf(snap.kind === "loaded" ? snap.usage : undefined);
    });
    // Each listed run's figures, keyed by run id — the same publish as the rows themselves, so a row
    // and its figure can never disagree about which read they came from.
    const runFigures = createMemo((): ReadonlyMap<string, LlmUsageTotals> => {
        const snap = runsSnapshot();
        return snap.kind === "loaded" ? (snap.usageByRun ?? new Map()) : new Map();
    });

    // DATA PROFILE / RUNS live data comes from the module store (see `hooks/sidebar_live.ts`), which
    // `App` refreshes on lifecycle edges + a bounded poll. The sidebar only reads the snapshots.
    const profileLine = createMemo(() => profileLineOf(profileSnapshot()));
    const recentRuns = createMemo((): CortexRunRow[] => {
        const s = runsSnapshot();
        if (s.kind !== "loaded") return [];
        // EVERY active run renders (each carries its own progress block), plus the newest few
        // terminal ones as plain rows. The cap applies only to the terminal tail: active runs are
        // bounded by real concurrency — one to three in practice — while finished runs accumulate
        // without limit, and capping the whole list would let a burst of completions push a running
        // run off the rail entirely.
        //
        // Order is the snapshot's own, which groups active runs above terminal ones and is
        // newest-first only WITHIN each group — a run started an hour ago and still going sits above
        // one that finished a minute ago. That is the useful reading for a rail (live work first, and
        // it is the work that changes), not an accident to correct; the runs picker carries the full
        // history in true chronological order.
        const active = s.runs.filter((r) => !RUN_STATUS_TERMINAL[r.status]);
        const terminal = s.runs.filter((r) => RUN_STATUS_TERMINAL[r.status]).slice(0, TERMINAL_RUN_ROWS);
        const keep = new Set([...active, ...terminal]);
        return s.runs.filter((r) => keep.has(r));
    });

    // The package-catalog lifecycle. The gate store polls the row that the detached downloader writes, so
    // these read one snapshot: memos, not bare accessors, because the line, the meter, and the update hint
    // must describe the SAME read — three independent calls could straddle a poll tick and disagree.
    const storeLine = createMemo(() => storeLineOf(libStoreGateState()));
    const storeMeter = createMemo(() => storeMeterOf(libStoreGateState()));
    const storeUpdateAvailable = createMemo((): boolean => {
        const gate = libStoreGateState();
        return gate.phase === "installed" && gate.updateAvailable;
    });

    // The role models are present exactly once the runtime installs the live switch at boot (all roles
    // seed together), so an empty pair reads as "not ready" — decoupled from the boot phase so the
    // section reflects the switch's own authority, not a second boot-phase read.
    const modelsReady = createMemo((): boolean => {
        const c = agentModels().current;
        return c.conversation !== "" || c.sandbox !== "" || c.utility !== "";
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
                    <Switch>
                        <Match when={openThread().kind === "unresolved"}>
                            <text fg={theme().fgMuted}>runtime not ready</text>
                        </Match>
                        <Match when={openThread().kind === "unavailable"}>
                            <text fg={theme().fgMuted}>unavailable</text>
                        </Match>
                        {/* A bound id with no row: the identity was minted at open and the first turn
                        creates the row, so there is no title or age to show yet. */}
                        <Match when={openThread().kind === "absent"}>
                            <text fg={theme().fgMuted}>new conversation</text>
                        </Match>
                        <Match when={thread()} keyed>
                            {(t: Thread) => (
                                <>
                                    {/* The title is pg-owned and seeded from the first user message, so a
                                    row can legitimately predate one; say so rather than render a blank line. */}
                                    <text fg={theme().fg}>{t.title ?? "untitled"}</text>
                                    <text fg={theme().fgMuted}>
                                        {Date.relativeAge(t.createdAt.getTime())} {GLYPHS.middot} {props.messageCount()} msgs
                                    </text>
                                </>
                            )}
                        </Match>
                    </Switch>
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
                    {/* The profile's spend belongs HERE and nowhere else in the rail: its calls carry no
                        thread, so they belong to no session and appear in no session figure. Without it
                        the work would be invisible in the rail while still counting toward the analysis. */}
                    <text>
                        {profileLine().glyph !== null ? <Fg role={profileLine().role}>{`${profileLine().glyph} `}</Fg> : null}
                        <Fg role="fgMuted">{profileLine().text}</Fg>
                        <EntityFigureSpan figure={profileFigure()} />
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
                                        // A finished run is a durable record, read long after "20h" meant anything —
                                        // pin its absolute finish time (terminal paths always stamp completedAt), in
                                        // the rail's compact form so name + anchor share the fixed-width row. Only a
                                        // still-live run keeps the relative age.
                                        const when = RUN_STATUS_TERMINAL[run.status] ? absTimeShort(run.completedAt) : relAge(run.startedAt);
                                        // This run's own progress, or undefined when it is terminal. Looking it up by
                                        // run id is what lets EVERY active run carry a block: the old store held one
                                        // newest-run slot, so a second concurrent run had no live surface at all.
                                        const progress = (): ActiveRunProgress | undefined => activeRunProgress().get(run.runId);
                                        // The plan's human title while the run is active; the id tail once it is not.
                                        // `shortRunName` is useless as a label — it resolves to "executeAnalysis" on
                                        // every row — and a terminal run has no progress entry to carry a title, so its
                                        // row keeps the id tail that at least distinguishes it.
                                        const label = (): string => progress()?.name ?? idTail(run.runId);
                                        return (
                                            <>
                                                {/* Name, age, spend — one middot-separated sequence. The spend is the
                                                containment the USAGE section's session figure folds in, shown
                                                here so the reader can see what that headline is made of. */}
                                                <text>
                                                    <Fg role={m.role}>{`${m.glyph} `}</Fg>
                                                    <Fg role="fgMuted">{label()}</Fg>
                                                    <Sep />
                                                    <Fg role="fgMuted">{when}</Fg>
                                                    <EntityFigureSpan figure={entityFigureOf(runFigures().get(run.runId))} />
                                                </text>
                                                {/* This run's live progress, directly under its own row. NON-keyed Show:
                                                each poll mints a fresh snapshot object, and keyed would tear down and
                                                remount the RunBlock every tick — non-keyed updates props in place.
                                                heading off: the run row above IS the heading. */}
                                                <Show when={progress()}>
                                                    {(p: Accessor<ActiveRunProgress>) => (
                                                        <RunBlock
                                                            name={p().name}
                                                            tag={p().tag}
                                                            done={p().done}
                                                            total={p().total}
                                                            steps={p().steps}
                                                            maxSteps={size.railStepRows}
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

                {/* Content rows, never the Section's label-row `value` slot: that slot always paints
                    the section foreground while every absence state here is deliberately muted, and a
                    value that changed rows with its tone would make the rail jump between renders.

                    The LONG form (`820.3k in`), not the compact arrows the DATA PROFILE and RUNS rows
                    carry: this section's entire subject is the number, so it is read rather than
                    scanned and the words cost it nothing — while a labelled figure on a row whose
                    subject is a run would crowd the name it annotates. Both come from the same arm, so
                    the rail and a run row can never disagree about a value, only about its writing.

                    The two arms share ONE row, input at the leading edge and output at the trailing
                    one, with each arm's parts indented beneath it. Two arms are peers the reader is
                    comparing, so each belongs at an edge it can be found at without scanning; the
                    indented parts are what state "these are inside that", which is the one thing the
                    layout must not level. Stacking the arms instead spent a rail row on a relationship
                    that is not there — the rail's rows are its scarcest resource and this section
                    shares them with five others. Same shape as the usage dialog's headline, from the
                    same component, so the two readings of one figure look like one notation. */}
                <Section label="USAGE" onActivate={props.onOpenUsage}>
                    <Show when={usageMessage()} keyed>
                        {(text: string) => (
                            <text>
                                <Fg role="fgMuted">{text}</Fg>
                            </text>
                        )}
                    </Show>
                    <Show when={usageQuantities()} keyed>
                        {(quantities: TokenQuantities) => <TokenFigure quantities={quantities} variant="long" />}
                    </Show>
                </Section>

                {/* The package catalog every sandbox mounts. It sits under USAGE and above MODELS, because
                    it is a prerequisite of the work rather than a report of it, and MODELS stays the
                    configuration footer. The state comes from the gate store, which polls the row that the
                    DETACHED downloader writes — the app starts no transfer of its own.

                    The meter is the ONE surface that carries this figure. The gate hold text and the status
                    bar both stay bare, so the reader never meets one transfer as two widgets. Before the
                    manifest resolves there is no total, thus the row reports the resolve step and draws no
                    meter rather than an estimate that would grow. */}
                <Section label="PACKAGES">
                    <text>
                        {storeLine().glyph !== null ? <Fg role={storeLine().role}>{`${storeLine().glyph} `}</Fg> : null}
                        <Fg role="fgMuted">{storeLine().text}</Fg>
                    </text>
                    <Show when={storeMeter()} keyed>
                        {(meter: { filled: string; empty: string }) => (
                            <text>
                                <Fg role="success">{meter.filled}</Fg>
                                <Fg role="fgSubtle">{meter.empty}</Fg>
                            </text>
                        )}
                    </Show>
                    {/* The user owns the update decision, so the rail NAMES the command and opens no prompt. */}
                    <Show when={storeUpdateAvailable()}>
                        <text>
                            <Fg role="fgMuted">inflexa store download --update</Fg>
                        </text>
                    </Show>
                </Section>

                <Section label="MODELS">
                    <Show when={modelsReady()} fallback={<text fg={theme().fgMuted}>runtime not ready</text>}>
                        <ConnectionLine />
                        <AgentModelLine label="chat" agent="conversation" />
                        <AgentModelLine label="sandbox" agent="sandbox" />
                        <AgentModelLine label="utility" agent="utility" />
                    </Show>
                </Section>
            </ScrollPane>
        </box>
    );
}
