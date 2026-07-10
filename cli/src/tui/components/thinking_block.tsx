import { Show } from "solid-js";

import { theme } from "../theme.ts";
import { GLYPHS, space, MARKERS } from "../../lib/design_system.ts";
import { Fg, Italic } from "./emphasis.tsx";

/** Props for {@link ThinkingBlock}. */
export type ThinkingBlockProps = {
    /** The reasoning body text. */
    text: string;
    /** Optional elapsed reasoning time, milliseconds. */
    durationMs?: number;
    /**
     * Whether the reasoning body is shown. Collapsed (false) by default — the
     * block is presentational and the caller owns the expand state, since stream
     * rows are not individually focusable yet (key-driven toggle is a follow-up).
     */
    expanded?: boolean;
};

/**
 * The thinking / reasoning block: the `◆ thinking` marker with an optional
 * duration, and a collapsed-by-default italic reasoning body behind an expand
 * affordance. The body sits under a left rule so it reads as quoted reasoning.
 */
export function ThinkingBlock(props: ThinkingBlockProps) {
    const duration = (): string => (props.durationMs ? ` ${GLYPHS.middot} ${Math.round(props.durationMs / 1000)}s` : "");
    return (
        <box flexDirection="column" paddingBottom={space.sm}>
            <text>
                <Fg role={MARKERS.thinking.role}>{`${MARKERS.thinking.glyph} thinking`}</Fg>
                <Fg role="fgMuted">{duration()}</Fg>
            </text>
            <Show
                when={props.expanded}
                fallback={
                    <text fg={theme().fgMuted} paddingLeft={space.md}>
                        {GLYPHS.arrowDown} expand {GLYPHS.middot} collapsed by default
                    </text>
                }
            >
                <box paddingLeft={space.md} border={["left"]} borderColor={theme().border}>
                    {/* italic = reasoning/quoted, per the Type & emphasis scale; muted color carries the meaning since terminals often drop italics. */}
                    <text>
                        <Fg role="fgMuted">
                            <Italic>{props.text}</Italic>
                        </Fg>
                    </text>
                </box>
            </Show>
        </box>
    );
}
