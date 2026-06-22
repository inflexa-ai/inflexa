import { For, Show } from "solid-js";
import type { Accessor } from "solid-js";

import { syntaxStyle, theme } from "../theme.ts";
import { MARKERS } from "./markers.ts";
import type { Part, TextPart } from "../../types/session.ts";

/** A chat turn's author. */
export type MessageRole = "user" | "assistant";

/** Props for {@link MessageBlock}. */
export type MessageBlockProps = {
    /** Who authored the turn — selects the gutter marker and its color. */
    role: MessageRole;
    /** The turn's parts (today: text parts only). */
    parts: Part[];
    /** The part id currently streaming, or null — read reactively. */
    streamPartId: Accessor<string | null>;
    /** The live streaming text for the streaming part — read reactively. */
    streamText: Accessor<string>;
};

/**
 * One chat turn: a role-colored gutter marker (`>` you / `<` assistant) and label, then the
 * markdown body indented under it. The marker swaps by role while the gutter stays fixed, so
 * future block types align identically. The streaming part renders from the live stream
 * accessors and flips to the stored text once the part completes. No meta footer is shown:
 * model/duration/tokens are not tracked, and fabricating them is not permitted.
 */
export function MessageBlock(props: MessageBlockProps) {
    return (
        <box width="100%" flexDirection="column" paddingBottom={1}>
            <text fg={theme()[props.role === "user" ? MARKERS.you.role : MARKERS.assistant.role]} attributes={1}>
                {props.role === "user" ? `${MARKERS.you.glyph} You` : `${MARKERS.assistant.glyph} Assistant`}
            </text>
            <For each={props.parts}>
                {(part) => {
                    const p = part as TextPart;
                    const isStreaming = () => props.streamPartId() === p.id;
                    const content = () => (isStreaming() ? props.streamText() : p.text);
                    return (
                        <Show when={content()}>
                            <markdown content={content()} fg={theme().fg} syntaxStyle={syntaxStyle()} streaming={isStreaming()} paddingLeft={2} />
                        </Show>
                    );
                }}
            </For>
        </box>
    );
}
