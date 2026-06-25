import { For, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";

import { syntaxStyle, theme } from "../theme.ts";
import { space, GLYPHS, MARKERS } from "../../lib/design_system.ts";
import { ThinkingBlock } from "../components/thinking_block.tsx";
import { ToolBlock } from "../components/tool_block.tsx";
import { DiffBlock } from "../components/diff_block.tsx";
import { Bold, Fg } from "../components/emphasis.tsx";
import type { Part } from "../../types/session.ts";

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
    /** The turn's parts (text, plus the mock thinking/tool/file-edit kinds). */
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
    // `· #N`, plus `· Ns` for a completed assistant turn (whole seconds, matching the thinking
    // block's readout). User turns and not-yet-finished assistant turns show only the number.
    const meta = (): string => {
        const dur = props.role === "assistant" && props.durationMs !== undefined ? ` ${GLYPHS.middot} ${Math.round(props.durationMs / 1000)}s` : "";
        return `  ${GLYPHS.middot} #${props.index}${dur}`;
    };
    return (
        <box width="100%" flexDirection="column" paddingBottom={space.sm}>
            <text fg={theme()[props.role === "user" ? MARKERS.you.role : MARKERS.assistant.role]}>
                <Bold>{props.role === "user" ? `${MARKERS.you.glyph} You` : `${MARKERS.assistant.glyph} Inflexa`}</Bold>
                <Fg role="fgSubtle">{meta()}</Fg>
            </text>
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
                                        paddingLeft={space.md}
                                    />
                                </Show>
                            );
                        }
                        case "thinking":
                            return <ThinkingBlock text={part.text} durationMs={part.durationMs} />;
                        case "tool-call":
                            return <ToolBlock name={part.name} target={part.target} result={part.result} filetype={part.filetype} status={part.status} />;
                        case "file-edit":
                            return <DiffBlock path={part.path} diff={part.diff} added={part.added} removed={part.removed} />;
                        default: {
                            // Exhaustive: a new Part kind without a case fails the build here.
                            const _exhaustive: never = part;
                            return _exhaustive;
                        }
                    }
                }}
            </For>
        </box>
    );
}
