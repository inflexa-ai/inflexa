import { Show } from "solid-js";

import { GLYPHS } from "../../lib/design_system.ts";
import { theme } from "../theme.ts";
import { Bold } from "../components/emphasis.tsx";

/** Which themed color the status bar's middle region uses. */
export type StatusTone = "success" | "warn" | "error";

/** Props for {@link StatusBar}. */
export type StatusBarProps = {
    /** Left identity, shown bold in the accent color (e.g. `inflexa`). */
    title: string;
    /** Optional secondary left text, shown muted (e.g. the active analysis name). */
    subtitle?: string;
    /** Optional middle region — the chat's live state or config's unsaved indicator. Omitted when undefined. */
    state?: { text: string; tone: StatusTone };
    /**
     * Optional working-directory path, shown muted immediately after the state as part of the
     * left-flowing segments (NOT a right hint). A wide-terminal-only affordance the caller gates on
     * the layout breakpoint; StatusBar stays dumb and simply renders whatever string it is handed.
     */
    path?: string;
    /** Right-aligned affordance labels (sourced from the keymap by the caller). */
    hints: string[];
    /**
     * Optional state-aware interrupt affordance, appended after {@link StatusBarProps.hints}. The caller
     * (the chat) derives the label from the live `app.interrupt` binding and the armed state and hands it
     * down as data — StatusBar stays dumb. When `armed`, the label renders in the accent color so the
     * "again to interrupt" state is visually distinct from the resting hint; omit it entirely when idle.
     */
    interruptHint?: { label: string; armed: boolean };
};

function toneColor(tone: StatusTone): string {
    const t = theme();
    return tone === "warn" ? t.warning : tone === "error" ? t.error : t.success;
}

/**
 * The shared app-shell status bar: left identity (+ optional subtitle), an OPTIONAL middle
 * state region, and right-aligned affordance hints. Composed by both the chat (`app.tsx`) and
 * the config screen. Imports only `theme`, so every region recolors live on a theme switch.
 */
export function StatusBar(props: StatusBarProps) {
    return (
        <box height={1} width="100%" flexDirection="row" backgroundColor={theme().bgRaised} paddingLeft={1} paddingRight={1}>
            <text fg={theme().accent}>
                <Bold>{props.title}</Bold>
            </text>
            <Show when={props.subtitle} keyed>
                {(subtitle: string) => <text fg={theme().fgMuted}> | {subtitle}</text>}
            </Show>
            <Show when={props.state} keyed>
                {(state: { text: string; tone: StatusTone }) => <text fg={toneColor(state.tone)}> | {state.text}</text>}
            </Show>
            <Show when={props.path} keyed>
                {(path: string) => <text fg={theme().fgMuted}> | {path}</text>}
            </Show>
            {/* Spacer pushes the affordance hints to the right edge. */}
            <box flexGrow={1} />
            <text fg={theme().fgMuted}>{props.hints.join(`  ${GLYPHS.middot}  `)}</text>
            {/* The interrupt hint carries its own color so the armed ("again to interrupt") state can accent
            while the resting hint stays muted; a separate <text> is needed because the hints above share one
            muted span. Both branches resolve an explicit fg. */}
            <Show when={props.interruptHint} keyed>
                {(hint: { label: string; armed: boolean }) => (
                    <text fg={hint.armed ? theme().accent : theme().fgMuted}>{`  ${GLYPHS.middot}  ${hint.label}`}</text>
                )}
            </Show>
        </box>
    );
}
