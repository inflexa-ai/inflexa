import { Show } from "solid-js";

import { GLYPHS } from "../../lib/glyphs.ts";
import { theme } from "../theme.ts";

/** Which themed color the status bar's middle region uses. */
export type StatusTone = "success" | "warn" | "error";

/** Props for {@link StatusBar}. */
export type StatusBarProps = {
    /** Left identity, shown bold in the accent color (e.g. `inf`). */
    title: string;
    /** Optional secondary left text, shown muted (e.g. the active analysis name). */
    subtitle?: string;
    /** Optional middle region — the chat's live state or config's unsaved indicator. Omitted when undefined. */
    state?: { text: string; tone: StatusTone };
    /** Right-aligned affordance labels (sourced from the keymap by the caller). */
    hints: string[];
};

function toneColor(tone: StatusTone): string {
    const t = theme();
    return tone === "warn" ? t.warn : tone === "error" ? t.error : t.success;
}

/**
 * The shared app-shell status bar: left identity (+ optional subtitle), an OPTIONAL middle
 * state region, and right-aligned affordance hints. Composed by both the chat (`app.tsx`) and
 * the config screen. Imports only `theme`, so every region recolors live on a theme switch.
 */
export function StatusBar(props: StatusBarProps) {
    return (
        <box height={1} width="100%" flexDirection="row" backgroundColor={theme().bgPanel} paddingLeft={1} paddingRight={1}>
            <text fg={theme().accent} attributes={1}>
                {props.title}
            </text>
            <Show when={props.subtitle} keyed>
                {(subtitle: string) => <text fg={theme().muted}> | {subtitle}</text>}
            </Show>
            <Show when={props.state} keyed>
                {(state: { text: string; tone: StatusTone }) => <text fg={toneColor(state.tone)}> | {state.text}</text>}
            </Show>
            {/* Spacer pushes the affordance hints to the right edge. */}
            <box flexGrow={1} />
            <text fg={theme().muted}>{props.hints.join(`  ${GLYPHS.middot}  `)}</text>
        </box>
    );
}
