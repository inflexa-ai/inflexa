import type { JSX } from "solid-js";
import type { BoxRenderable } from "@opentui/core";

import { size, space } from "../../lib/design_system.ts";
import { theme } from "../theme.ts";
import { Fg } from "./emphasis.tsx";

/** Props for {@link PromptFrame}. */
export type PromptFrameProps = {
    /** The glyph in the fixed-width gutter. */
    glyph: string;
    /**
     * True for a static gallery exhibit: the frame stays non-focusable, so a click on it cannot take
     * the focus of the gallery pane. Live docks leave it unset so the host can focus the box and the
     * prompt's target-gated key layer engages.
     */
    inert?: boolean;
    /**
     * Receives the frame's focusable box on mount. The prompt hands the same renderable to its key
     * layer (`target`) and to its own host, which focuses it when the prompt becomes active.
     */
    onReady?: (r: BoxRenderable) => void;
    /** The prompt's own content, in the column beside the gutter. */
    children: JSX.Element;
};

/**
 * The shared chrome of the docked prompts (`ask_prompt.tsx`, `pause_prompt.tsx`): a full-width,
 * non-collapsing row painted with the raised panel background, so it can sit directly below the
 * chat's `flexGrow` scrollbox (the 1-cell scrollbox-bleed rule) without transcript content bleeding
 * through its gaps, laid out as the fixed marker gutter + content column the transcript blocks align
 * to. Each prompt keeps its own bindings and its own key layer; this carries only the box, the inert
 * focus rule, and the gutter row.
 */
export function PromptFrame(props: PromptFrameProps): JSX.Element {
    return (
        <box
            ref={(r: BoxRenderable) => {
                // opentui's mousedown-autofocus walks from the clicked child to the nearest focusable
                // ancestor, so an inert gallery exhibit must stay non-focusable — otherwise any click
                // on it (an option, the prose) yanks focus off the gallery pane. Live docks opt in so
                // the host can focus the box and the prompt's target-gated key layer engages.
                r.focusable = !(props.inert ?? false);
                props.onReady?.(r);
            }}
            width="100%"
            flexShrink={0}
            flexDirection="row"
            backgroundColor={theme().bgRaised}
            paddingLeft={space.sm}
            paddingRight={space.sm}
        >
            {/* Fixed-width so the content column starts at the same indent on every row; flexShrink={0}
            because a narrow terminal must squeeze the text, never the gutter. */}
            <box width={size.gutter} flexShrink={0}>
                <text>
                    <Fg role="warning">{props.glyph}</Fg>
                </text>
            </box>
            <box flexDirection="column" flexGrow={1}>
                {props.children}
            </box>
        </box>
    );
}
