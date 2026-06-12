import { render, useKeyboard, useRenderer } from "@opentui/solid";
import { createSignal, For, Show } from "solid-js";

import { readConfig, writeConfig, type Config } from "../lib/config.ts";
import { env } from "../lib/env.ts";
import { shutdown } from "../lib/shutdown.ts";

interface Setting {
    key: keyof Config;
    label: string;
    description: string;
}

const settings: Setting[] = [
    {
        key: "telemetry",
        label: "telemetry",
        description:
            "Export structured log records (event types, IDs, lengths, error types) to your OTLP endpoint. " +
            "Message, prompt, and code content is redacted before anything leaves this machine.",
    },
];

interface Notice {
    kind: "info" | "warn" | "error";
    text: string;
}

const noticeColors: Record<Notice["kind"], string> = {
    info: "#9ece6a",
    warn: "#e0af68",
    error: "#f7768e",
};

export function ConfigApp() {
    const renderer = useRenderer();
    const [saved, setSaved] = createSignal(readConfig());
    const [draft, setDraft] = createSignal(readConfig());
    const [selected, setSelected] = createSignal(0);
    const [notice, setNotice] = createSignal<Notice | null>(null);
    const [quitArmed, setQuitArmed] = createSignal(false);

    const dirty = () => settings.some((s) => draft()[s.key] !== saved()[s.key]);

    function toggle() {
        const setting = settings[selected()]!;
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
            setSelected((i) => Math.max(0, i - 1));
        } else if (key.name === "down") {
            setSelected((i) => Math.min(settings.length - 1, i + 1));
        }
    });

    return (
        <box flexDirection="column" width="100%" height="100%">
            <box height={1} width="100%" flexDirection="row" backgroundColor="#1a1b26" paddingLeft={1} paddingRight={1}>
                <text fg="#7aa2f7" attributes={1}>
                    inf config
                </text>
                <text fg="#565f89"> | Space/Enter: toggle | s: save | q/Esc: exit</text>
                <Show when={dirty()}>
                    <text fg="#e0af68"> | unsaved changes</text>
                </Show>
            </box>

            <For each={settings}>
                {(setting, index) => (
                    <box flexDirection="column" paddingLeft={2} paddingTop={1}>
                        <text fg={index() === selected() ? "#7dcfff" : "#c0caf5"} attributes={1}>
                            [{draft()[setting.key] ? "x" : " "}] {setting.label}
                            {draft()[setting.key] !== saved()[setting.key] ? " *" : ""}
                        </text>
                        <box paddingLeft={4} flexDirection="column">
                            <text fg="#565f89">{setting.description}</text>
                            <Show when={setting.key === "telemetry"}>
                                <text fg="#565f89">Endpoint: {env.otelEndpoint ?? "not set (OTEL_EXPORTER_OTLP_ENDPOINT)"}</text>
                            </Show>
                        </box>
                    </box>
                )}
            </For>

            <Show when={notice()}>
                <box paddingLeft={2} paddingTop={1}>
                    <text fg={noticeColors[notice()!.kind]}>{notice()!.text}</text>
                </box>
            </Show>

            <box paddingLeft={2} paddingTop={1}>
                <text fg="#565f89">File: {env.configPath}</text>
            </box>
        </box>
    );
}

export async function launchConfig() {
    void render(() => <ConfigApp />, {
        exitOnCtrlC: false,
        targetFps: 30,
        screenMode: "alternate-screen",
    });
}
