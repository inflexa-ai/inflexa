import { Show } from "solid-js";

import { theme } from "../theme.ts";
import { GLYPHS, space } from "../../lib/design_system.ts";
import { Sep } from "./separator.tsx";

/** Props for {@link CompactionBlock}. */
export type CompactionBlockProps = {
    /** `running` while the harness summarizes the conversation, then the terminal status. */
    status: "running" | "done" | "failed";
    /** The estimate of the context before the compaction, in tokens. */
    tokensBefore: number;
    /** The estimate of the context after the compaction. Absent when the compaction left no marker. */
    tokensAfter?: number;
    durationMs?: number;
};

// Longer than any terminal is wide: each rule box clips it to the cells that it gets.
const RULE = GLYPHS.lineHorizontal.repeat(512);

/** One side of the divider: a rule that takes the cells that the label leaves. */
function Rule() {
    return (
        <box flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} height={1} overflow="hidden">
            <text wrapMode="none" fg={theme().fgSubtle}>
                {RULE}
            </text>
        </box>
    );
}

/**
 * One muted progress line while the harness summarizes the earlier conversation, then a divider with the
 * result: the mark between the summarized part of the conversation and the rest.
 */
export function CompactionBlock(props: CompactionBlockProps) {
    const figures = (): string =>
        props.tokensAfter === undefined ? "" : `${props.tokensBefore.formatTokens()} ${GLYPHS.arrowRight} ${props.tokensAfter.formatTokens()}`;
    return (
        <Show
            when={props.status !== "running"}
            fallback={
                <box paddingBottom={space.sm}>
                    <text fg={theme().fgMuted}>{`Summarizing earlier conversation${GLYPHS.ellipsis}`}</text>
                </box>
            }
        >
            <box flexDirection="row" width="100%" paddingBottom={space.sm}>
                <Rule />
                <text flexShrink={1} fg={theme().fgMuted}>
                    {" "}
                    <Show
                        when={props.status === "done"}
                        fallback={
                            <>
                                Could not summarize earlier conversation
                                <Show when={figures()}>
                                    <Sep />
                                    dropped the oldest turns
                                    <Sep />
                                    {figures()}
                                </Show>
                            </>
                        }
                    >
                        Summarized earlier conversation
                        <Show when={figures()}>
                            <Sep />
                            {figures()}
                        </Show>
                        <Show when={props.durationMs !== undefined}>
                            <Sep />
                            {Date.formatDuration(props.durationMs ?? 0)}
                        </Show>
                    </Show>{" "}
                </text>
                <Rule />
            </box>
        </Show>
    );
}
