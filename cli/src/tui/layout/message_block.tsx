import { For, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { unwrap } from "solid-js/store";
import type { Thread, ToolCallOutcome } from "@inflexa-ai/harness";
import type { ChatMessage } from "@inflexa-ai/harness/contracts/message.js";

import { syntaxStyle, theme } from "../theme.ts";
import { space, GLYPHS, MARKERS, type ThemeColors } from "../../lib/design_system.ts";
import { formatTokenFigureLabelled } from "../../lib/usage_format.ts";
import { ThinkingBlock } from "../components/thinking_block.tsx";
import { ToolBlock, type ToolBlockProps } from "../components/tool_block.tsx";
import { DiffBlock } from "../components/diff_block.tsx";
import { PlanCardBlock } from "../components/plan_card_block.tsx";
import { RunCardBlock, type RunCardState } from "../components/run_card_block.tsx";
import { PresentationBlock } from "../components/presentation_block.tsx";
import { OpenableCardBlock, type OpenableRowView } from "../components/openable_card_block.tsx";
import { ReportSessionBlock } from "../components/report_session_block.tsx";
import { CompactionBlock } from "../components/compaction_block.tsx";
import { Bold, Fg, Italic } from "../components/emphasis.tsx";
import { useWorkspace } from "../contexts/workspace.ts";
import { reportChildren } from "../hooks/report_children.ts";
import { entryDegraded, readFileReference, readPresentation, resolveEntryPath } from "../../modules/harness/artifact_open.ts";
import { readAskPart, readChildSessionStarted, readCompactionPart, readPlanCard, readRunCard } from "../../modules/harness/chat_printer.ts";
import { openArtifact, openArtifactFolder } from "../hooks/artifacts.ts";
import { activeRunProgress, runsSnapshot, RUN_STATUS_TERMINAL } from "../hooks/sidebar_live.ts";
import type { TurnUsage } from "../../modules/harness/turn.ts";
import type { LiveAskPart, OpenableEntry, Part } from "../../types/session.ts";

/**
 * Resolve a run card's settled state from the sidebar's ledger snapshots, by the `runId` the card
 * already carries — no new persisted field, and nothing the card has to have been told at launch.
 *
 * Returns `undefined` when the run simply is not in what has been read. That is the common case for
 * scroll-back: the runs snapshot holds only the newest few rows, so an older card's run was never
 * fetched. Not-fetched is not the same as not-found, and rendering "unavailable" for it would put a
 * false negative on every historical card. `unavailable` is reserved for a positive finding — the
 * read itself failed — so the card says so only when there is something to say.
 */
export function resolveRunCardState(runId: string): RunCardState | undefined {
    // A run that is currently active resolves to NO state: the card renders its launch record and
    // nothing else, because live progress belongs to the rail and the run-activity panel. This has to
    // be answered before the ladder below rather than folded into it — the two run reads can leave
    // `runsSnapshot` at `unavailable` while the active-run map still holds this run, and reporting a
    // run known to be live as unresolvable is the one falsehood this function exists to avoid.
    if (activeRunProgress().has(runId)) return undefined;

    const snap = runsSnapshot();
    if (snap.kind === "unavailable") return { kind: "unavailable" };
    if (snap.kind !== "loaded") return undefined;

    const row = snap.runs.find((r) => r.runId === runId);
    if (!row || !RUN_STATUS_TERMINAL[row.status]) return undefined;

    const start = Date.parse(row.startedAt);
    const end = row.completedAt === null ? NaN : Date.parse(row.completedAt);
    // Counts are deliberately absent: a terminal run has left `activeRunProgress`, taking its step
    // counts with it, and a reloaded transcript never had them. The block omits the segment rather
    // than printing a fabricated `0/0`.
    return {
        kind: "settled",
        status: row.status,
        durationMs: Number.isNaN(start) || Number.isNaN(end) ? null : end - start,
        error: row.error,
    };
}

/** Props for {@link MessageBlock}. */
export type MessageBlockProps = {
    /** 1-based position of this turn in the rendered conversation, shown beside the role label. */
    index: number;
    /**
     * Who authored the turn — selects the gutter marker and its color. `system` is not a turn: it is a
     * record that the host appended to the thread, or the divider of a compaction.
     */
    role: ChatMessage["role"];
    /**
     * Assistant-only turn duration in ms, shown beside the number. Two sources feed one prop — the live
     * turn stamps it at settlement, and a transcript reload reads back what the turn append stored — thus
     * a reopened conversation shows the time that the live header showed. Omitted on a user turn, before
     * the turn finishes, and on a row that predates the durable field. A measured zero still renders,
     * because a turn that settled inside one millisecond took a time that somebody measured.
     */
    durationMs?: number;
    /**
     * Assistant-only: what the whole turn consumed, rendered beside the duration as an input figure and
     * an output figure. Omitted whenever the run reported nothing — the meta line then shows the
     * duration alone, with no zero and no placeholder, because "no provider reported anything" and
     * "nothing was spent" are different facts and only the second one is a number.
     */
    turnUsage?: TurnUsage;
    /**
     * Assistant-only: the turn was interrupted after it had streamed output, so the header carries a muted
     * "interrupted" marker. Two sources feed one flag — the live abort path sets it directly, and a
     * transcript reload re-derives it from the persisted message's `interrupted` marker, so a restarted app
     * renders the same marker the live view showed. Never set on a user turn; a no-output abort has no
     * assistant message to carry it (that empty shell is dropped rather than marked).
     */
    interrupted?: boolean;
    /** The turn's parts: the harness parts, plus the mock thinking/file-edit kinds of the gallery. */
    parts: Part[];
    /** The key of the text part currently streaming, or null — read reactively. */
    streamPartId: Accessor<string | null>;
    /** The live streaming text for the streaming part — read reactively. */
    streamText: Accessor<string>;
};

/**
 * The lifecycle that a tool block shows for the outcome of a call.
 *
 * The harness records a call's whole terminal state in one field, so this is a total mapping with
 * nothing left to infer — which is the point: two hosts reading the same projection cannot disagree
 * about what a call did, and the `never` branch makes a state added later a build failure here
 * rather than a silent mis-render.
 *
 * An absent outcome is a live call still in flight. `incomplete` — a reloaded call that the turn cut
 * off — maps to the same `running`, which is what actually happened. It does not read as live because
 * the message carries the interruption badge; the marker and that badge together say "in flight when
 * the turn was cut off", so a renderer must not show one without the other.
 */
function toolStatus(outcome: ToolCallOutcome | undefined): ToolBlockProps["status"] {
    switch (outcome) {
        case "ok":
        case "error":
        case "denied":
            return outcome;
        case "incomplete":
        case undefined:
            return "running";
        default: {
            const unhandled: never = outcome;
            throw new Error(`unhandled tool call outcome: ${String(unhandled)}`);
        }
    }
}

/** The one-line tagged mention of a part that has no renderer here — observed, never swallowed. */
function mention(type: string): string {
    return `[part:${type}]`;
}

/** A text body of a turn, through the `<markdown>` renderable. An empty body renders nothing. */
function MarkdownBody(props: { content: string; paddingLeft: number }): JSX.Element {
    return (
        <Show when={props.content}>
            {/* Mirror opencode's markdown config exactly. `streaming` is pinned true, NOT
                isStreaming(): in @opentui/core 0.4.0 `<markdown streaming={false}>` renders
                nothing (verified headlessly), so a finalized/reloaded part would vanish the
                instant the stream ends. `internalBlockMode="top-level"` is the streaming
                block mode — without it, incrementally-grown content left inline syntax
                (`**bold**`) rendered as raw literal `**`. */}
            <markdown
                content={props.content}
                fg={theme().fg}
                syntaxStyle={syntaxStyle()}
                streaming={true}
                internalBlockMode="top-level"
                paddingLeft={props.paddingLeft}
            />
        </Show>
    );
}

/**
 * One chat turn: a role-colored gutter marker (`>` you / `<` assistant) and label, then each part
 * rendered as its own gutter-marked block under it. This is the bridge from the harness parts to the
 * domain-agnostic block widgets in `components/`: it switches on the part discriminant and reads each
 * card through the shared reader that the REPL printer also uses, thus a live card and its reload
 * render alike. The `never`-typed default makes a new part kind without a renderer a compile error.
 * The streaming text part renders from the live stream accessors and flips to the stored text once
 * the part completes.
 */
export function MessageBlock(props: MessageBlockProps) {
    // `· #N`, plus `· <dur>` and `· <in> in · <out> out` for a completed assistant turn, through the
    // shared Date.formatDuration and token-figure vocabularies. User turns carry no figure — the cost
    // was not incurred by the party that sent the message — and a not-yet-finished turn has none.
    const meta = (): string => {
        const assistant = props.role === "assistant";
        const dur = assistant && props.durationMs !== undefined ? ` ${GLYPHS.middot} ${Date.formatDuration(props.durationMs)}` : "";
        // The LONG form, unlike the rail's run and step rows. This header runs the full width of the
        // stream and carries three or four facts at most, so it has the cells to spend; and it is the
        // one place a figure appears on EVERY turn, which makes it the place a reader learns to read
        // the notation — words teach it, arrows assume it has already been taught.
        //
        // The headline pair only. The rollup's other three quantities are breakdowns, and a breakdown
        // is honest only where there is room to label what it is a breakdown OF — which a one-line
        // header does not have. The formatter yields "" when the provider reported neither.
        const usage = assistant && props.turnUsage !== undefined ? formatTokenFigureLabelled(props.turnUsage) : "";
        // Guarded so an unreported turn appends nothing at all — not a separator with empty figures
        // after it, which would read as a measurement that failed to print.
        const spend = usage === "" ? "" : ` ${GLYPHS.middot} ${usage}`;
        return `  ${GLYPHS.middot} #${props.index}${dur}${spend}`;
    };
    // Body indent, kept gutter-aligned across roles. An assistant body pads by space.md (2). A user
    // body rides a left border rule (the quoted-content idiom), whose glyph eats one gutter cell — so it
    // pads by space.sm (1) instead: border(1) + padding(1) === space.md, landing user and assistant
    // body text in the SAME column. This sum is the invariant: change one term and the other must move
    // to match, or the two roles misalign under their headers.
    const bodyPadLeft = (): number => (props.role === "user" ? space.sm : space.md);
    // A reloaded compaction divider spans the transcript on its own, thus it takes no event rule.
    const dividerOnly = (): boolean => props.role === "system" && props.parts.length === 1 && props.parts[0]?.type === "data-compaction";
    // A part object never changes in place: each edit of the store gives a fresh object, which `<For>`
    // mounts as a new item. Thus a card reads its part through the shared reader one time, here.
    const parts = (): JSX.Element => (
        <For each={props.parts}>
            {(part): JSX.Element => {
                switch (part.type) {
                    case "text": {
                        // The content switches source: the live `streamText` while the part streams, and
                        // the stored `part.text` once it is flushed.
                        const isStreaming = (): boolean => props.streamPartId() === part.key;
                        return <MarkdownBody content={isStreaming() ? props.streamText() : part.text} paddingLeft={bodyPadLeft()} />;
                    }
                    case "thinking":
                        return <ThinkingBlock text={part.text} durationMs={part.durationMs} />;
                    case "tool-call":
                        return (
                            <ToolBlock
                                name={part.toolName}
                                detail={part.detail}
                                status={toolStatus(part.outcome)}
                                durationMs={part.durationMs}
                                activity={part.activity}
                            />
                        );
                    case "file-edit":
                        return <DiffBlock path={part.path} diff={part.diff} added={part.added} removed={part.removed} />;
                    case "data-plan": {
                        const plan = readPlanCard(part);
                        return <PlanCardBlock planId={plan.planId} title={plan.title} steps={plan.steps} />;
                    }
                    case "data-run-card": {
                        const run = readRunCard(part);
                        return <RunCardBlock runId={run.runId} title={run.title} stepCount={run.stepCount} state={resolveRunCardState(run.runId)} />;
                    }
                    case "data-presentation": {
                        // The reader deep-copies the chart spec, and a store proxy cannot be cloned, thus
                        // the reader gets the plain part that the proxy wraps.
                        const view = readPresentation(unwrap(part));
                        return view.shape === "inline" ? (
                            <PresentationBlock title={view.title} body={view.body} />
                        ) : (
                            <OpenableCard title={view.title} entries={[view.entry]} />
                        );
                    }
                    case "data-file-reference": {
                        const view = readFileReference(part);
                        return <OpenableCard title={view.title} entries={view.entries} folderPath={view.folderPath} />;
                    }
                    case "data-ask":
                        return <AskCard part={part} />;
                    case "data-child-session-started": {
                        const started = readChildSessionStarted(part);
                        return started.threadType === "report" ? (
                            <ReportSessionEntry threadId={started.threadId} />
                        ) : (
                            <MarkdownBody content={mention(part.type)} paddingLeft={bodyPadLeft()} />
                        );
                    }
                    case "data-compaction": {
                        const compaction = readCompactionPart(part);
                        return (
                            <CompactionBlock
                                status={compaction.status}
                                tokensBefore={compaction.tokensBefore}
                                tokensAfter={compaction.tokensAfter}
                                durationMs={compaction.durationMs}
                            />
                        );
                    }
                    // The parts that the conversation has no first-class renderer for: the sidebar parts
                    // of a run, and the record of a report render.
                    case "data-report-rendered":
                    case "data-run-started":
                    case "data-dag-state":
                    case "data-step-activity":
                    case "data-step-file-tree":
                    case "data-step-output":
                    case "data-step-summary":
                    case "data-step-usage":
                    case "data-step-blocked":
                    case "data-run-synthesis":
                    case "data-synthesis-progress":
                    case "data-run-completed":
                    case "data-run-failed":
                        return <MarkdownBody content={mention(part.type)} paddingLeft={bodyPadLeft()} />;
                    default: {
                        // Exhaustive: a new Part kind without a case fails the build here. A frame keeps a
                        // `data-*` type that this build does not know, thus a part can still reach here at
                        // run time, and it renders the mention. The cast only reads the discriminant that
                        // every part carries.
                        const unknownPart: never = part;
                        return <MarkdownBody content={mention((unknownPart as { type: string }).type)} paddingLeft={bodyPadLeft()} />;
                    }
                }
            }}
        </For>
    );
    return (
        <box width="100%" flexDirection="column" paddingBottom={space.sm}>
            {/* An event entry carries NEITHER turn marker and no turn number: it is not a turn, and the
            transcript's turn-scoped affordances must not count it. Its whole body renders behind a
            subtle rule — the visual register of "the system noted this", distinct at a glance from the
            user's bordered quote and the assistant's unindented prose, so nobody can read it as either
            party speaking. A `<Show>` rather than an early return: Solid components run once, and an
            early return would break the block's reactivity outright. */}
            <Show
                when={props.role === "system"}
                fallback={
                    <>
                        <text fg={theme()[props.role === "user" ? MARKERS.you.role : MARKERS.assistant.role]}>
                            <Bold>{props.role === "user" ? `${MARKERS.you.glyph} You` : `${MARKERS.assistant.glyph} Inflexa`}</Bold>
                            <Fg role="fgMuted">{meta()}</Fg>
                            {/* Muted suffix marking a turn the user interrupted after it began streaming. It rides the
                            header row, never the fixed gutter, so its separator can be the same registry middot the
                            meta uses; the enclosing <text> already resolves an explicit fg. */}
                            <Show when={props.interrupted}>
                                <Fg role="fgMuted">{` ${GLYPHS.middot} interrupted`}</Fg>
                            </Show>
                        </text>
                        {props.role === "user" ? (
                            // The user turn's body rides a left border rule in the user color (the quoted-content idiom
                            // shared with the thinking / plan-card / run blocks). The header sits OUTSIDE this box so its
                            // gutter marker column never shifts; only the body is indented under the rule.
                            <box flexDirection="column" border={["left"]} borderColor={theme().user}>
                                {parts()}
                            </box>
                        ) : (
                            parts()
                        )}
                    </>
                }
            >
                <Show when={!dividerOnly()} fallback={parts()}>
                    <box flexDirection="column" border={["left"]} borderColor={theme().fgSubtle} paddingLeft={space.sm}>
                        {parts()}
                    </box>
                </Show>
            </Show>
        </box>
    );
}

/**
 * The transcript entry for one report session, anchored by its persisted `data-child-session-started`
 * part (thread type `report`) and joined by thread id against the live report-children listing. The listing is the authority for the
 * session: its title, its activity stamp, and its liveness come from the row, thus a part whose row
 * the listing does not hold — an archived child, or a listing that failed — renders nothing. `Chat`
 * renders the same entry at the transcript tail for a row that no mounted part claims, for example a
 * session spawned before the part became durable.
 *
 * Reads the workspace context for the in-place open, thus a mount outside the provider is a wiring
 * bug — the same rule as each other consumer of {@link useWorkspace}.
 */
export function ReportSessionEntry(props: { threadId: string }) {
    const ws = useWorkspace();
    const row = (): Thread | undefined => reportChildren().find((child) => child.threadId === props.threadId);
    // An unscoped chat has no analysis to open a session against, thus the click does nothing.
    const open = (): void => {
        const analysis = ws.analysis;
        if (!analysis) return;
        ws.openSession(props.threadId, ws.workingDir, analysis);
    };
    // The title is pg-owned and seeded from the first message of the session, thus a row can
    // legitimately carry none. Say so rather than render a blank line, as the sidebar SESSION rail does.
    return (
        <Show when={row()}>
            {(child: Accessor<Thread>): JSX.Element => (
                <ReportSessionBlock title={child().title ?? "untitled"} activityLabel={Date.relativeAge(child().updatedAt.getTime())} onOpen={open} />
            )}
        </Show>
    );
}

/**
 * Wire the openable entries of a harness part (a pixel-shaped presentation, or a file reference) to the
 * pure {@link OpenableCardBlock}: resolve each entry's display path and degraded state at render time
 * (open-time resolution — the part stores only the reference), and hand clicks to the shared opener.
 * Co-located with {@link MessageBlock}, its only caller. Resolution reads the memoized workspace root, so
 * the one-time read per mount is cheap; parts are immutable after receipt, so a static resolution is
 * correct.
 *
 * The entries resolve against the analysis of the open workspace: the transcript of a session belongs to
 * that analysis, and a swap resets the transcript. Thus a mount outside the workspace provider is a
 * wiring bug, the same rule as {@link ReportSessionEntry}. With no analysis open, no entry resolves, and
 * each one renders degraded.
 */
function OpenableCard(props: { title?: string; entries: OpenableEntry[]; folderPath?: string }) {
    const ws = useWorkspace();
    const analysisId = (): string => ws.analysis?.id ?? "";
    const rows = (): OpenableRowView[] =>
        props.entries.map((entry) => ({
            name: entry.name,
            ...(entry.caption !== undefined ? { caption: entry.caption } : {}),
            path: resolveEntryPath(analysisId(), entry.target),
            degraded: entryDegraded(analysisId(), entry.target),
        }));
    function openFolder(): void {
        const folderPath = props.folderPath;
        if (folderPath) openArtifactFolder(analysisId(), folderPath);
    }
    return (
        <OpenableCardBlock
            title={props.title}
            rows={rows()}
            folderLabel={props.folderPath ? "Open containing folder" : undefined}
            onOpen={(index) => {
                const entry = props.entries[index];
                if (entry) openArtifact(analysisId(), entry);
            }}
            onOpenFolder={props.folderPath ? openFolder : undefined}
        />
    );
}

/**
 * Map an ask card's status to its gutter marker: a caution sign while pending, then a settled outcome
 * glyph in the matching status color (approved → success check, rejected → error cross, and a hollow
 * no-decision dot for a turn that aborted or an ask that expired). The status word carries the exact
 * meaning; the marker gives it an at-a-glance color.
 *
 * Pending is the caution sign rather than the half-circle so the app keeps ONE marker per meaning. The
 * half-circle denotes system-busy everywhere else here — chat thinking, harness booting, a running
 * sidebar entry — but a pending ask is not the system working; it is the system stopped, waiting on the
 * user, which is exactly what caution means. It is also the same glyph the docked approval prompt
 * shows, so one pending ask no longer wears two different markers depending on where you look at it.
 */
function askMarker(status: LiveAskPart["status"]): { glyph: string; role: keyof ThemeColors } {
    switch (status) {
        case "pending":
            return { glyph: GLYPHS.warning, role: "warning" };
        case "resolved":
            return { glyph: GLYPHS.check, role: "success" };
        case "rejected":
            return { glyph: GLYPHS.cross, role: "error" };
        case "aborted":
        case "expired":
            return { glyph: GLYPHS.circleHollow, role: "fgMuted" };
        default: {
            // Exhaustive: a new ask status without a marker fails the build here.
            const _exhaustive: never = status;
            return _exhaustive;
        }
    }
}

/**
 * The ask-card block: a status-colored marker with the approval headline and its status word, the exact
 * command being approved on the line below, and an optional detail line. It renders the harness ask part
 * through `readAskPart`, which gives a status outside the union as `expired`, a terminal status: thus a
 * malformed part never renders as pending. A reload gives the terminal status that the harness closed
 * the ask with, and never the reject feedback, which is live screen state. Co-located with
 * {@link MessageBlock}, its only caller.
 */
function AskCard(props: { part: LiveAskPart }) {
    const ask = (): ReturnType<typeof readAskPart> => readAskPart(props.part);
    const marker = (): { glyph: string; role: keyof ThemeColors } => askMarker(ask().status);
    const heading = (): string => ask().title || ask().command;
    return (
        <box flexDirection="column" paddingBottom={space.sm}>
            <text>
                <Fg role={marker().role}>{`${marker().glyph} `}</Fg>
                <Fg role="fg">{heading()}</Fg>
                <Fg role="fgMuted">{` ${GLYPHS.middot} ${ask().status}`}</Fg>
            </text>
            <text paddingLeft={space.md}>
                <Fg role="fgMuted">{ask().command}</Fg>
            </text>
            <Show when={ask().detail}>
                {(detail: Accessor<string>): JSX.Element => (
                    <text paddingLeft={space.md}>
                        <Fg role="fgSubtle">{detail()}</Fg>
                    </text>
                )}
            </Show>
            {/* The user's own typed reject feedback, echoed onto the card by the answering surface — quoted
            muted so it reads as their words, not the tool's. Only a rejection carries feedback. */}
            <Show when={ask().status === "rejected" && props.part.feedback}>
                {(feedback: Accessor<string>): JSX.Element => (
                    <text paddingLeft={space.md}>
                        <Fg role="fgMuted">feedback: </Fg>
                        <Fg role="fgSubtle">
                            <Italic>{feedback()}</Italic>
                        </Fg>
                    </text>
                )}
            </Show>
        </box>
    );
}
