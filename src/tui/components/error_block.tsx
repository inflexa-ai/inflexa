import { Show } from "solid-js";

import { theme } from "../theme.ts";
import { GLYPHS, space, stroke, MARKERS } from "../../lib/design_system.ts";
import { Bold } from "./emphasis.tsx";

/** Props for {@link ErrorBlock}. */
export type ErrorBlockProps = {
    /** One-line abort/error summary shown beside the `✗` marker. */
    summary: string;
    /** The error detail line shown inside the callout (e.g. `EACCES · anchor not writable`). */
    detail?: string;
    /** Optional consequence note under the detail (e.g. why identity degraded). */
    note?: string;
    /** Recovery affordances (e.g. `/reanchor`, `r retry`). */
    hints?: string[];
};

/**
 * The error / abort block: the `✗` marker with a summary, then a bordered callout
 * (error-colored frame) holding the error detail, an optional consequence note,
 * and recovery affordances. The double `stroke.danger` frame is deliberately NOT
 * used here — it is reserved for destructive *confirmation*, not error display.
 */
export function ErrorBlock(props: ErrorBlockProps) {
    return (
        <box flexDirection="column" paddingBottom={space.sm}>
            <text fg={theme()[MARKERS.error.role]}>
                <Bold>
                    {MARKERS.error.glyph} {props.summary}
                </Bold>
            </text>
            <box
                marginTop={space.sm}
                flexDirection="column"
                paddingLeft={space.sm}
                paddingRight={space.sm}
                borderStyle={stroke.panel}
                borderColor={theme().error}
            >
                <Show when={props.detail}>
                    <text fg={theme().error}>
                        {GLYPHS.warning} {props.detail}
                    </text>
                </Show>
                <Show when={props.note}>
                    <text fg={theme().fgMuted}>{props.note}</text>
                </Show>
                <Show when={props.hints?.length}>
                    <text fg={theme().accent}>{props.hints!.join(`  ${GLYPHS.middot}  `)}</text>
                </Show>
            </box>
        </box>
    );
}
