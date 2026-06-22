import { render, useKeyboard, useRenderer } from "@opentui/solid";
import { createEffect, createSignal, For, Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";

import { readConfig, writeConfig, type Config } from "../lib/config.ts";
import { env } from "../lib/env.ts";
import { GLYPHS } from "../lib/glyphs.ts";
import { shutdown } from "../lib/shutdown.ts";
import { setTheme, theme, noticeColor, type Notice } from "./theme.ts";
import { StatusBar } from "./layout/status_bar.tsx";
import { KEYMAP } from "./keymap.ts";
import { themes, themeIds } from "../lib/themes.ts";
import { runtimes, runtimeIds } from "../lib/container.ts";

/** Config keys whose value is a boolean — the toggleable settings. */
type BooleanSettingKey = { [K in keyof Config]: Config[K] extends boolean ? K : never }[keyof Config];

type Setting = {
    key: BooleanSettingKey;
    label: string;
    description: string;
};

const settings: Setting[] = [
    {
        key: "telemetry",
        label: "telemetry",
        description:
            "Export structured log records (event types, IDs, lengths, error types) to your OTLP endpoint. " +
            "Message, prompt, and code content is redacted before anything leaves this machine.",
    },
];

/**
 * Two-level navigation model. Up/down move between SECTIONS (each boolean toggle is
 * its own section, then the theme radio group, then the runtime radio group);
 * left/right change the focused section's value. A radio section needs no separate
 * cursor — its highlighted option is always the active draft value, which left/right
 * moves (preview and selection are unified) — so a Section carries only its kind.
 */
type Section = { kind: "toggle"; settingIndex: number } | { kind: "theme" } | { kind: "runtime" };
const sections: Section[] = [...settings.map((_, i): Section => ({ kind: "toggle", settingIndex: i })), { kind: "theme" }, { kind: "runtime" }];
/** Section indices of the two radio groups (the toggles occupy `0 … settings.length-1`). */
const THEME_SECTION = settings.length;
const RUNTIME_SECTION = settings.length + 1;

export function ConfigApp(props: { onClose?: () => void }) {
    const renderer = useRenderer();
    // Read config once; saved and draft both start from it. Focus starts on the first
    // section (the telemetry toggle) — the top of the form — so every section, including
    // the toggles, is reachable by walking down from a fixed, predictable origin.
    const initial = readConfig();
    const [saved, setSaved] = createSignal(initial);
    const [draft, setDraft] = createSignal(initial);
    const [section, setSection] = createSignal(0);
    const [notice, setNotice] = createSignal<Notice | null>(null);
    const [quitArmed, setQuitArmed] = createSignal(false);

    // The form is taller than a short terminal can show. Without a scroll container the
    // flex column shrinks every section's height to fit, painting rows on top of each
    // other (the overlapping theme list). The scrollbox lets sections keep their natural
    // height and clips overflow; this effect keeps the focused section in view as the
    // user walks down with up/down (which drive section nav, not the scrollbox directly).
    let scrollRef: ScrollBoxRenderable | null = null;
    createEffect(() => {
        scrollRef?.scrollChildIntoView(`section-${section()}`);
    });

    const dirty = () => settings.some((s) => draft()[s.key] !== saved()[s.key]) || draft().theme !== saved().theme || draft().runtime !== saved().runtime;

    // Left/right change the focused section's value. Radios step through their option
    // list (clamped, with live theme preview); the toggle is a two-state control on the
    // same axis — left → off, right → on (idempotent, unlike a flip). Any value change
    // clears a stale notice and disarms the quit confirmation.
    function step(delta: -1 | 1): void {
        const s = sections[section()]!;
        switch (s.kind) {
            case "toggle": {
                const { key } = settings[s.settingIndex]!;
                setDraft({ ...draft(), [key]: delta === 1 });
                break;
            }
            case "theme": {
                const id = themeIds[Math.min(themeIds.length - 1, Math.max(0, themeIds.indexOf(draft().theme) + delta))]!;
                setTheme(id);
                setDraft({ ...draft(), theme: id });
                break;
            }
            case "runtime": {
                const id = runtimeIds[Math.min(runtimeIds.length - 1, Math.max(0, runtimeIds.indexOf(draft().runtime) + delta))]!;
                setDraft({ ...draft(), runtime: id });
                break;
            }
            default: {
                // Exhaustiveness: a new Section kind must add a case above, or this breaks the build.
                const _exhaustive: never = s;
                void _exhaustive;
            }
        }
        setNotice(null);
        setQuitArmed(false);
    }

    // Space/enter flip the focused toggle; a no-op on radio sections (whose value is
    // already applied live by step). Mirrors a checkbox's familiar space-to-toggle.
    function toggleFocused(): void {
        const s = sections[section()]!;
        if (s.kind !== "toggle") return;
        const { key } = settings[s.settingIndex]!;
        setDraft({ ...draft(), [key]: !draft()[key] });
        setNotice(null);
        setQuitArmed(false);
    }

    function save() {
        if (!dirty()) {
            setNotice({ kind: "info", text: "No changes to save." });
            return;
        }
        const next = draft();
        writeConfig(next).match(
            () => {
                setSaved(next);
                setNotice({ kind: "info", text: "Saved." });
                setQuitArmed(false);
            },
            (error) => setNotice({ kind: "error", text: `Failed to save: ${error.type}` }),
        );
    }

    function exit() {
        // Revert any unsaved live theme preview to the persisted selection.
        setTheme(saved().theme);
        // Embedded as a dialog: hand control back to the host (which owns the dialog stack)
        // instead of tearing down the shared renderer — destroying it would kill the whole TUI.
        if (props.onClose) {
            props.onClose();
            return;
        }
        // Standalone: destroy() restores the terminal (mouse tracking, alternate
        // screen, cooked mode) — process.exit() alone skips OpenTUI's
        // beforeExit cleanup and leaves the shell broken.
        renderer.destroy();
        void shutdown(0);
    }

    useKeyboard((key) => {
        if (key.name === "q" || key.name === "escape" || (key.name === "c" && key.ctrl)) {
            if (dirty() && !quitArmed()) {
                setQuitArmed(true);
                setNotice({ kind: "warn", text: "Unsaved changes — press s to save, or q/Esc again to discard." });
                return;
            }
            exit();
        } else if (key.name === "s") {
            save();
        } else if (key.name === "space" || key.name === "return") {
            toggleFocused();
        } else if (key.name === "up") {
            // Pure navigation between sections — no draft change, so it leaves any notice /
            // quit-arm state intact (only value edits clear those).
            setSection(Math.max(0, section() - 1));
        } else if (key.name === "down") {
            setSection(Math.min(sections.length - 1, section() + 1));
        } else if (key.name === "left") {
            step(-1);
        } else if (key.name === "right") {
            step(1);
        }
    });

    return (
        // Paint the screen with the theme background; otherwise the terminal's own
        // background shows through and light themes render dark text on a black screen.
        <box flexDirection="column" width="100%" height="100%" backgroundColor={theme().bg}>
            <StatusBar
                title="inf config"
                state={dirty() ? { text: "unsaved changes", tone: "warn" } : undefined}
                hints={[
                    `${KEYMAP.moveSelection.label} section`,
                    `${KEYMAP.changeOption.label} change`,
                    `${KEYMAP.save.label} save`,
                    `${KEYMAP.exit.label} exit`,
                ]}
            />

            <scrollbox
                ref={(r: ScrollBoxRenderable) => {
                    scrollRef = r;
                }}
                flexGrow={1}
                minHeight={0}
                width="100%"
            >
                <For each={settings}>
                    {(setting, index) => (
                        <box id={`section-${index()}`} flexDirection="column" paddingLeft={2} paddingTop={1}>
                            <text fg={index() === section() ? theme().selected : theme().fg} attributes={1}>
                                [{draft()[setting.key] ? "x" : " "}] {setting.label}
                                {draft()[setting.key] !== saved()[setting.key] ? " *" : ""}
                            </text>
                            <box paddingLeft={4} flexDirection="column">
                                <text fg={theme().muted}>{setting.description}</text>
                                <Show when={setting.key === "telemetry"}>
                                    <text fg={theme().muted}>Endpoint: {env.otelEndpoint ?? "not set (OTEL_EXPORTER_OTLP_ENDPOINT)"}</text>
                                </Show>
                            </box>
                        </box>
                    )}
                </For>

                <box id={`section-${THEME_SECTION}`} flexDirection="column" paddingLeft={2} paddingTop={1}>
                    <text fg={section() === THEME_SECTION ? theme().accent : theme().muted}>theme</text>
                    <For each={themeIds}>
                        {(id) => {
                            // No separate cursor: the highlighted row is always the active draft theme
                            // (left/right move it). Bright `selected` when this section is focused, the
                            // dimmer `accent` when it isn't, plain `fg` for the rest.
                            const isActive = () => draft().theme === id;
                            return (
                                <box paddingLeft={2}>
                                    <text fg={isActive() && section() === THEME_SECTION ? theme().selected : isActive() ? theme().accent : theme().fg}>
                                        {isActive() ? `(${GLYPHS.circle})` : "( )"} {themes[id].name}
                                        {isActive() && saved().theme !== id ? " *" : ""}
                                    </text>
                                </box>
                            );
                        }}
                    </For>
                </box>

                <box id={`section-${RUNTIME_SECTION}`} flexDirection="column" paddingLeft={2} paddingTop={1}>
                    <text fg={section() === RUNTIME_SECTION ? theme().accent : theme().muted}>container runtime</text>
                    <For each={runtimeIds}>
                        {(id) => {
                            const isActive = () => draft().runtime === id;
                            return (
                                <box paddingLeft={2}>
                                    <text fg={isActive() && section() === RUNTIME_SECTION ? theme().selected : isActive() ? theme().accent : theme().fg}>
                                        {isActive() ? `(${GLYPHS.circle})` : "( )"} {runtimes[id].label}
                                        {isActive() && saved().runtime !== id ? " *" : ""}
                                    </text>
                                </box>
                            );
                        }}
                    </For>
                </box>
            </scrollbox>

            <Show when={notice()}>
                <box paddingLeft={2} paddingTop={1}>
                    <text fg={noticeColor(notice()!.kind)}>{notice()!.text}</text>
                </box>
            </Show>

            <box paddingLeft={2} paddingTop={1}>
                <text fg={theme().muted}>File: {env.configPath}</text>
            </box>
        </box>
    );
}

export async function launchConfig() {
    // Seed the active theme from persisted config before the renderer reads it.
    setTheme(readConfig().theme);

    void render(() => <ConfigApp />, {
        exitOnCtrlC: false,
        targetFps: 30,
        screenMode: "alternate-screen",
    });
}
