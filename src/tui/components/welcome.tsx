import { Show } from "solid-js";

import { theme } from "../theme.ts";
import { GLYPHS, space } from "../../lib/design_system.ts";

/** Props for {@link Welcome}. */
export type WelcomeProps = {
    /** Greeting line, e.g. `welcome to inf`. */
    greeting: string;
    /** Active anchor path, shown with a health badge. Omitted when none. */
    anchorPath?: string;
    /** Whether the anchor's on-disk marker is present (✓) or not (⚠). */
    markerWritten?: boolean;
    /** Bottom hint affordances, e.g. `run /init`, `ctrl+k for commands`. All keybinds are Ctrl-based (see CLAUDE.md). */
    hints?: string[];
};

/**
 * The welcome / startup block: the `inf` wordmark (rendered with the native
 * `<ascii_font>`), a greeting, the active anchor path with a health badge, and
 * bottom hints. Purely presentational — the caller supplies anchor/greeting data
 * it has already read, so this block touches no disk (the no-litter rule).
 */
export function Welcome(props: WelcomeProps) {
    return (
        <box flexDirection="column" paddingBottom={space.md}>
            <ascii_font text="inf" color={theme().accent} />
            <text fg={theme().fg} paddingTop={space.sm}>
                {props.greeting}
            </text>
            <Show when={props.anchorPath}>
                <text fg={theme().fgMuted}>
                    {props.markerWritten ? GLYPHS.check : GLYPHS.warning} {props.anchorPath}
                </text>
            </Show>
            <Show when={props.hints?.length}>
                <text fg={theme().fgSubtle} paddingTop={space.sm}>
                    {props.hints!.join(`  ${GLYPHS.middot}  `)}
                </text>
            </Show>
        </box>
    );
}
