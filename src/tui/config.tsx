import { render, useKeyboard, useRenderer } from "@opentui/solid";
import { createSignal, For, Show } from "solid-js";

import { readConfig, writeConfig, type Config } from "../lib/config.ts";
import { env } from "../lib/env.ts";
import { shutdown } from "../lib/shutdown.ts";
import { setTheme, theme } from "./theme.ts";
import { themes, themeIds, type ThemeId } from "../lib/themes.ts";

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
 * Navigable rows: the boolean toggles first, then one row per theme. `selected`
 * indexes into this flat list so up/down moves across both sections.
 */
type Row = { kind: "toggle"; settingIndex: number } | { kind: "theme"; id: ThemeId };
const rows: Row[] = [...settings.map((_, i): Row => ({ kind: "toggle", settingIndex: i })), ...themeIds.map((id): Row => ({ kind: "theme", id }))];

type Notice = {
    kind: "info" | "warn" | "error";
    text: string;
};

export function ConfigApp() {
    const renderer = useRenderer();
    // Read config once: saved and draft both start from it, and the cursor starts
    // on the active theme's row so up/down move relative to the marked selection
    // (not the telemetry row at index 0).
    const initial = readConfig();
    const [saved, setSaved] = createSignal(initial);
    const [draft, setDraft] = createSignal(initial);
    const [selected, setSelected] = createSignal(settings.length + themeIds.indexOf(initial.theme));
    const [notice, setNotice] = createSignal<Notice | null>(null);
    const [quitArmed, setQuitArmed] = createSignal(false);

    const dirty = () => settings.some((s) => draft()[s.key] !== saved()[s.key]) || draft().theme !== saved().theme;

    // Notice colors must be read reactively (not precomputed at module load)
    // so they recolor when the theme changes.
    function noticeColor(kind: Notice["kind"]): string {
        const t = theme();
        return kind === "warn" ? t.warn : kind === "error" ? t.error : t.info;
    }

    // Move the highlight; landing on a theme row previews it live and makes it
    // the draft selection (preview and selection are unified for themes).
    function selectRow(index: number) {
        setSelected(index);
        const row = rows[index]!;
        if (row.kind === "theme") {
            setTheme(row.id);
            setDraft({ ...draft(), theme: row.id });
            setNotice(null);
            setQuitArmed(false);
        }
    }

    function toggle() {
        const row = rows[selected()]!;
        if (row.kind !== "toggle") return;
        const setting = settings[row.settingIndex]!;
        setDraft({ ...draft(), [setting.key]: !draft()[setting.key] });
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
        // destroy() restores the terminal (mouse tracking, alternate
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
            toggle();
        } else if (key.name === "up") {
            selectRow(Math.max(0, selected() - 1));
        } else if (key.name === "down") {
            selectRow(Math.min(rows.length - 1, selected() + 1));
        }
    });

    return (
        // Paint the screen with the theme background; otherwise the terminal's own
        // background shows through and light themes render dark text on a black screen.
        <box flexDirection="column" width="100%" height="100%" backgroundColor={theme().bg}>
            <box height={1} width="100%" flexDirection="row" backgroundColor={theme().bgPanel} paddingLeft={1} paddingRight={1}>
                <text fg={theme().accent} attributes={1}>
                    inf config
                </text>
                <text fg={theme().muted}> | ↑/↓: move | Space/Enter: toggle | s: save | q/Esc: exit</text>
                <Show when={dirty()}>
                    <text fg={theme().warn}> | unsaved changes</text>
                </Show>
            </box>

            <For each={settings}>
                {(setting, index) => (
                    <box flexDirection="column" paddingLeft={2} paddingTop={1}>
                        <text fg={index() === selected() ? theme().selected : theme().fg} attributes={1}>
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

            <box flexDirection="column" paddingLeft={2} paddingTop={1}>
                <text fg={theme().muted}>theme</text>
                <For each={themeIds}>
                    {(id, j) => {
                        const rowIndex = () => settings.length + j();
                        const isSelected = () => selected() === rowIndex();
                        const isActive = () => draft().theme === id;
                        return (
                            <box paddingLeft={2}>
                                <text fg={isSelected() ? theme().selected : isActive() ? theme().accent : theme().fg}>
                                    {isActive() ? "(●)" : "( )"} {themes[id].name}
                                    {isActive() && saved().theme !== id ? " *" : ""}
                                </text>
                            </box>
                        );
                    }}
                </For>
            </box>

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
