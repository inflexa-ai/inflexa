import { For, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";

import { syntaxStyle, theme } from "../theme.ts";
import { space, GLYPHS, MARKERS, type ThemeColors } from "../../lib/design_system.ts";
import { ThinkingBlock } from "../components/thinking_block.tsx";
import { ToolBlock } from "../components/tool_block.tsx";
import { DiffBlock } from "../components/diff_block.tsx";
import { PlanCardBlock } from "../components/plan_card_block.tsx";
import { RunCardBlock } from "../components/run_card_block.tsx";
import { PresentationBlock } from "../components/presentation_block.tsx";
import { OpenableCardBlock, type OpenableRowView } from "../components/openable_card_block.tsx";
import { Bold, Fg, Italic } from "../components/emphasis.tsx";
import { entryDegraded, resolveEntryPath } from "../../modules/harness/artifact_open.ts";
import { openArtifact, openArtifactFolder } from "../hooks/artifacts.ts";
import type { AskCardPart, OpenableCardPart, Part } from "../../types/session.ts";

/** A chat turn's author. */
export type MessageRole = "user" | "assistant";

/** Props for {@link MessageBlock}. */
export type MessageBlockProps = {
    /** 1-based position of this turn in the rendered conversation, shown beside the role label. */
    index: number;
    /** Who authored the turn — selects the gutter marker and its color. */
    role: MessageRole;
    /** Assistant-only turn duration in ms; shown beside the number. Omitted on user turns and before the turn finishes. */
    durationMs?: number;
    /**
     * Assistant-only: the turn was interrupted after it had streamed output, so the header carries a muted
     * "interrupted" marker. A live-only flag (an aborted turn persists no assistant message), never set on
     * a user turn or on a no-output abort (that empty shell is dropped rather than marked).
     */
    interrupted?: boolean;
    /** The turn's parts (text, tool-call, plan-card, run-card, plus the mock thinking/file-edit kinds). */
    parts: Part[];
    /** The part id currently streaming, or null — read reactively. */
    streamPartId: Accessor<string | null>;
    /** The live streaming text for the streaming part — read reactively. */
    streamText: Accessor<string>;
};

/**
 * One chat turn: a role-colored gutter marker (`>` you / `<` assistant) and label, then each part
 * rendered as its own gutter-marked block under it. This is the bridge from the domain `Part`
 * union to the domain-agnostic block widgets in `components/`: it switches on the part discriminant
 * and maps each kind to its widget's primitive props. The `never`-typed default makes a new part
 * kind without a renderer a compile error. The streaming text part renders from the live stream
 * accessors and flips to the stored text once the part completes.
 */
export function MessageBlock(props: MessageBlockProps) {
    // `· #N`, plus `· <dur>` for a completed assistant turn (via the shared Date.formatDuration
    // vocabulary). User turns and not-yet-finished assistant turns show only the number.
    const meta = (): string => {
        const dur = props.role === "assistant" && props.durationMs !== undefined ? ` ${GLYPHS.middot} ${Date.formatDuration(props.durationMs)}` : "";
        return `  ${GLYPHS.middot} #${props.index}${dur}`;
    };
    // Body indent, kept gutter-aligned across roles. An assistant body pads by space.md (2). A user
    // body rides a left border rule (the quoted-content idiom), whose glyph eats one gutter cell — so it
    // pads by space.sm (1) instead: border(1) + padding(1) === space.md, landing user and assistant
    // body text in the SAME column. This sum is the invariant: change one term and the other must move
    // to match, or the two roles misalign under their headers.
    const bodyPadLeft = (): number => (props.role === "user" ? space.sm : space.md);
    const parts = (): JSX.Element => (
        <For each={props.parts}>
            {(part): JSX.Element => {
                switch (part.type) {
                    case "text": {
                        const isStreaming = (): boolean => props.streamPartId() === part.id;
                        const content = (): string => (isStreaming() ? props.streamText() : part.text);
                        return (
                            <Show when={content()}>
                                {/* Mirror opencode's markdown config exactly. `streaming` is pinned true, NOT
                                    isStreaming(): in @opentui/core 0.4.0 `<markdown streaming={false}>` renders
                                    nothing (verified headlessly), so a finalized/reloaded part would vanish the
                                    instant the stream ends. `internalBlockMode="top-level"` is the streaming
                                    block mode — without it, incrementally-grown content left inline syntax
                                    (`**bold**`) rendered as raw literal `**`. content() switches source (live
                                    streamText while streaming, stored part.text once flushed). */}
                                <markdown
                                    content={content()}
                                    fg={theme().fg}
                                    syntaxStyle={syntaxStyle()}
                                    streaming={true}
                                    internalBlockMode="top-level"
                                    paddingLeft={bodyPadLeft()}
                                />
                            </Show>
                        );
                    }
                    case "thinking":
                        return <ThinkingBlock text={part.text} durationMs={part.durationMs} />;
                    case "tool-call":
                        return (
                            <ToolBlock
                                name={part.name}
                                target={part.target}
                                result={part.result}
                                filetype={part.filetype}
                                status={part.status}
                                durationMs={part.durationMs}
                            />
                        );
                    case "file-edit":
                        return <DiffBlock path={part.path} diff={part.diff} added={part.added} removed={part.removed} />;
                    case "plan-card":
                        return <PlanCardBlock planId={part.planId} title={part.title} steps={part.steps} />;
                    case "run-card":
                        return <RunCardBlock runId={part.runId} title={part.title} stepCount={part.stepCount} />;
                    case "presentation":
                        return <PresentationBlock title={part.title} body={part.body} />;
                    case "openable-card":
                        return <OpenableCard part={part} />;
                    case "ask-card":
                        return <AskCard part={part} />;
                    default: {
                        // Exhaustive: a new Part kind without a case fails the build here.
                        const _exhaustive: never = part;
                        return _exhaustive;
                    }
                }
            }}
        </For>
    );
    return (
        <box width="100%" flexDirection="column" paddingBottom={space.sm}>
            <text fg={theme()[props.role === "user" ? MARKERS.you.role : MARKERS.assistant.role]}>
                <Bold>{props.role === "user" ? `${MARKERS.you.glyph} You` : `${MARKERS.assistant.glyph} Inflexa`}</Bold>
                <Fg role="fgMuted">{meta()}</Fg>
                {/* Muted suffix marking a turn the user interrupted after it began streaming — plain ASCII so
                it never touches the fixed gutter; the enclosing <text> already resolves an explicit fg. */}
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
        </box>
    );
}

/**
 * Wire an {@link OpenableCardPart} to the pure {@link OpenableCardBlock}: resolve each entry's display path
 * and degraded state at render time (open-time resolution — the part stores only the reference), and hand
 * clicks to the shared opener. Co-located with {@link MessageBlock}, its only caller. Resolution reads the
 * memoized workspace root, so the one-time read per mount is cheap; parts are immutable after receipt, so a
 * static resolution is correct.
 */
function OpenableCard(props: { part: OpenableCardPart }) {
    const rows = (): OpenableRowView[] =>
        props.part.entries.map((entry) => ({
            name: entry.name,
            ...(entry.caption !== undefined ? { caption: entry.caption } : {}),
            path: resolveEntryPath(props.part.analysisId, entry.target),
            degraded: entryDegraded(props.part.analysisId, entry.target),
        }));
    function openFolder(): void {
        const folderPath = props.part.folderPath;
        if (folderPath) openArtifactFolder(props.part.analysisId, folderPath);
    }
    return (
        <OpenableCardBlock
            title={props.part.title}
            rows={rows()}
            folderLabel={props.part.folderPath ? "Open containing folder" : undefined}
            onOpen={(index) => {
                const entry = props.part.entries[index];
                if (entry) openArtifact(props.part.analysisId, entry);
            }}
            onOpenFolder={props.part.folderPath ? openFolder : undefined}
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
function askMarker(status: AskCardPart["status"]): { glyph: string; role: keyof ThemeColors } {
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
 * command being approved on the line below, and an optional detail line. It renders the primitive fields
 * the reconciling {@link AskCardPart} carries (copied at receipt) — a live-turn-only visual, never
 * reconstructed on reload. Co-located with {@link MessageBlock}, its only caller.
 */
function AskCard(props: { part: AskCardPart }) {
    const marker = (): { glyph: string; role: keyof ThemeColors } => askMarker(props.part.status);
    const heading = (): string => props.part.title || props.part.command;
    return (
        <box flexDirection="column" paddingBottom={space.sm}>
            <text>
                <Fg role={marker().role}>{`${marker().glyph} `}</Fg>
                <Fg role="fg">{heading()}</Fg>
                <Fg role="fgMuted">{` ${GLYPHS.middot} ${props.part.status}`}</Fg>
            </text>
            <text paddingLeft={space.md}>
                <Fg role="fgMuted">{props.part.command}</Fg>
            </text>
            <Show when={props.part.detail}>
                {(detail: Accessor<string>): JSX.Element => (
                    <text paddingLeft={space.md}>
                        <Fg role="fgSubtle">{detail()}</Fg>
                    </text>
                )}
            </Show>
            {/* The user's own typed reject feedback, echoed onto the card by the answering surface — quoted
            muted so it reads as their words, not the tool's. Only a rejection carries feedback. */}
            <Show when={props.part.status === "rejected" && props.part.feedback}>
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
