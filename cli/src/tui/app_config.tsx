import { render, useRenderer } from "@opentui/solid";
import { createEffect, createSignal, For, Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";

import { readConfig, resolvePostgresConfig, writeConfig, type Config } from "../lib/config.ts";
import { env } from "../lib/env.ts";
import { GLYPHS, themes, themeIds } from "../lib/design_system.ts";
import { shutdown } from "../lib/shutdown.ts";
import { setTheme, theme, noticeColor, type Notice } from "./theme.ts";
import { StatusBar } from "./layout/status_bar.tsx";
import { useKeymapRoot, KEYS, chordLabel } from "./keymap.ts";
import { DialogOverlay, dialogPush, dialogClose, useDialogBindings, useDialogClose, useDialogCloseGuard } from "./components/dialog/dialog_host.tsx";
import { Bold, Reverse, Fg } from "./components/emphasis.tsx";
import { PromptDialog } from "./components/dialog/prompt_dialog.tsx";
import { ScrollPane } from "./components/scroll_pane.tsx";
import { runtimes, runtimeIds } from "../lib/container.ts";

// `-?` strips optionality in the mapping: without it, an optional Config field (e.g. `keybinds`)
// makes its mapped value `never | undefined`, leaking `undefined` into the indexed union.
/** Config keys whose value is a boolean — the toggleable settings. */
type BooleanSettingKey = { [K in keyof Config]-?: Config[K] extends boolean ? K : never }[keyof Config];

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
 * its own section, then the theme radio group, then the runtime radio group, then
 * postgres fields); left/right change the focused section's value. A radio section
 * needs no separate cursor — its highlighted option is always the active draft value,
 * which left/right moves. A Section carries only its kind.
 */
type Section = { kind: "toggle"; settingIndex: number } | { kind: "theme" } | { kind: "runtime" } | { kind: "postgres_field"; field: PgField };

const PG_FIELDS = ["host", "port", "database", "user", "password"] as const;
type PgField = (typeof PG_FIELDS)[number];

const PG_FIELD_LABELS: Record<PgField, string> = {
    host: "host",
    port: "port",
    database: "database",
    user: "user",
    password: "password",
};

const sections: Section[] = [
    ...settings.map((_, i): Section => ({ kind: "toggle", settingIndex: i })),
    { kind: "theme" },
    { kind: "runtime" },
    ...PG_FIELDS.map((f): Section => ({ kind: "postgres_field", field: f })),
];
/** Section indices of the radio groups (the toggles occupy `0 … settings.length-1`). */
const THEME_SECTION = settings.length;
const RUNTIME_SECTION = settings.length + 1;
const PG_FIELD_SECTIONS_START = settings.length + 2;

export function ConfigApp(props: { onClose?: () => void }) {
    const renderer = useRenderer();
    // Read config once; saved and draft both start from it. Focus starts on the first
    // section (the telemetry toggle) — the top of the form — so every section, including
    // the toggles, is reachable by walking down from a fixed, predictable origin.
    // Seed postgres with resolved defaults so the form shows every field even when
    // config.json has no `postgres` key. writeConfig persists these explicit values.
    const initial = { ...readConfig(), postgres: resolvePostgresConfig() };
    const [saved, setSaved] = createSignal(initial);
    const [draft, setDraft] = createSignal(initial);
    const [section, setSection] = createSignal(0);
    const [notice, setNotice] = createSignal<Notice | null>(null);
    const [quitArmed, setQuitArmed] = createSignal(false);

    // Embedded as a dialog: the host's esc / click-outside / ctrl+c route here instead of popping
    // the entry outright, so the two-press dirty guard survives every dismissal gesture, not just
    // the form-layer keys. Both hooks are no-ops standalone (no entry).
    useDialogCloseGuard((reason) => {
        if (reason === "commit") return true;
        if (dirty() && !quitArmed()) {
            armQuit();
            return false;
        }
        return true;
    });
    // A non-commit pop skips exit(), so the live theme preview must revert here.
    useDialogClose((reason) => {
        if (reason !== "commit") setTheme(saved().theme);
    });

    /** The draft's postgres config — guaranteed non-null (seeded with resolved defaults). */
    const pgDraft = () => draft().postgres!;
    /** The saved postgres config — guaranteed non-null (seeded with resolved defaults). */
    const pgSaved = () => saved().postgres!;

    // The form is taller than a short terminal can show. Without a scroll container the
    // flex column shrinks every section's height to fit, painting rows on top of each
    // other (the overlapping theme list). The scrollbox lets sections keep their natural
    // height and clips overflow; this effect keeps the focused section in view as the
    // user walks down with up/down (which drive section nav, not the scrollbox directly).
    let scrollRef: ScrollBoxRenderable | null = null;
    createEffect(() => {
        scrollRef?.scrollChildIntoView(`section-${section()}`);
    });

    const dirty = () =>
        settings.some((s) => draft()[s.key] !== saved()[s.key]) ||
        draft().theme !== saved().theme ||
        draft().runtime !== saved().runtime ||
        PG_FIELDS.some((f) => pgDraft()[f] !== pgSaved()[f]);

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
            case "postgres_field": {
                break;
            }
            default: {
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

    // Enter on a postgres_field section opens a prompt dialog for inline text editing. Goes
    // through the dialog host (embedded: stacks on this screen's entry, suspending the form's
    // keys; standalone: the DialogOverlay rendered below hosts it) — the form layer's bare keys
    // (`s`, `q`, space) stay suspended while the prompt is open, so they type into the field.
    function editFocusedPgField(): void {
        const s = sections[section()]!;
        if (s.kind !== "postgres_field") return;
        const field = s.field;
        dialogPush(() => (
            <PromptDialog
                title={`postgres.${field}`}
                value={String(pgDraft()[field])}
                onSubmit={(value: string) => {
                    dialogClose();
                    setPgField(field, value);
                }}
                onCancel={() => {}}
            />
        ));
    }

    function setPgField(field: PgField, value: string): void {
        const trimmed = value.trim();
        if (field === "port") {
            const n = Number(trimmed);
            if (!Number.isInteger(n) || n <= 0 || n > 65535) {
                setNotice({ kind: "error", text: `"${trimmed}" is not a valid port number (1-65535).` });
                return;
            }
            setDraft({ ...draft(), postgres: { ...pgDraft(), port: n } });
        } else if (trimmed === "") {
            setNotice({ kind: "error", text: "Value cannot be empty." });
            return;
        } else {
            setDraft({ ...draft(), postgres: { ...pgDraft(), [field]: trimmed } });
        }
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

    /** First exit attempt with unsaved changes arms the confirm; shared by the form keys and the host veto. */
    function armQuit(): void {
        setQuitArmed(true);
        setNotice({ kind: "warn", text: "Unsaved changes — press s to save, or q/Esc again to discard." });
    }

    // First q/Esc/ctrl+c with unsaved changes arms a confirm; the second discards and exits.
    function requestExit(): void {
        if (dirty() && !quitArmed()) {
            armQuit();
            return;
        }
        exit();
    }

    // Standalone (`inflexa config`): this screen owns the renderer, so install the root keymap handler
    // here. Embedded as a dialog: the host `App` already installed it — a second root would
    // double-dispatch every key — so we only register our bindings layer below.
    // eslint-disable-next-line solid/reactivity -- seed-once: props.onClose is fixed at mount (embedded vs standalone never changes), so this one-time read correctly decides which mode installs the root
    if (!props.onClose) useKeymapRoot();

    // Dialog-entry gated: live while this screen is the top entry (embedded) or while no dialog
    // is open (standalone) — so the pg-field prompt suspends these bare keys (`q`, `s`, space,
    // arrows) and they type into the field instead of firing form actions. The ctrl+c here quits
    // this screen — distinct from the chat's remappable `app.abort`.
    useDialogBindings(() => ({
        bindings: [
            { chord: KEYS.q, run: requestExit },
            { chord: KEYS.escape, run: requestExit },
            { chord: { key: "c", ctrl: true }, run: requestExit },
            { chord: { key: "s" }, run: save },
            { chord: KEYS.space, run: toggleFocused },
            {
                chord: KEYS.enter,
                run: () => {
                    const s = sections[section()]!;
                    if (s.kind === "postgres_field") editFocusedPgField();
                    else toggleFocused();
                },
            },
            // Section nav wraps end-to-end so a long form is fully reachable without a direction
            // change: stepping down off the last section lands on the first, up off the first on
            // the last. (The radios' left/right value stepping stays clamped — wrapping a setting's
            // value past its ends would be a surprise, not a convenience.)
            { chord: KEYS.up, run: () => setSection((section() - 1 + sections.length) % sections.length) },
            { chord: KEYS.down, run: () => setSection((section() + 1) % sections.length) },
            { chord: KEYS.left, run: () => step(-1) },
            { chord: KEYS.right, run: () => step(1) },
        ],
    }));

    return (
        // Paint the screen with the theme background; otherwise the terminal's own
        // background shows through and light themes render dark text on a black screen.
        <box flexDirection="column" width="100%" height="100%" backgroundColor={theme().bg}>
            <StatusBar
                title="inflexa config"
                state={dirty() ? { text: "unsaved changes", tone: "warn" } : undefined}
                hints={[
                    `${chordLabel(KEYS.up)}/${chordLabel(KEYS.down)} section`,
                    `${chordLabel(KEYS.left)}/${chordLabel(KEYS.right)} change`,
                    `s save`,
                    `${chordLabel(KEYS.escape)} exit`,
                ]}
            />

            {/* Never focused (the config screen's keys drive section nav), so ScrollPane's scroll
            keys stay dead — the pane is just the shared scrollbox wrapper. */}
            <ScrollPane
                focusOnMount={false}
                onRef={(r: ScrollBoxRenderable) => {
                    scrollRef = r;
                }}
                flexGrow={1}
                minHeight={0}
                width="100%"
            >
                <For each={settings}>
                    {(setting, index) => {
                        const focused = () => index() === section();
                        const label = () =>
                            `[${draft()[setting.key] ? "x" : " "}] ${setting.label}${draft()[setting.key] !== saved()[setting.key] ? " *" : ""}`;
                        return (
                            <box id={`section-${index()}`} flexDirection="column" paddingLeft={2} paddingTop={1}>
                                <text fg={theme().fg}>
                                    {focused() ? (
                                        <Reverse>
                                            <Bold>{label()}</Bold>
                                        </Reverse>
                                    ) : (
                                        <Bold>{label()}</Bold>
                                    )}
                                </text>
                                <box paddingLeft={4} flexDirection="column">
                                    <text fg={theme().fgMuted}>{setting.description}</text>
                                    <Show when={setting.key === "telemetry"}>
                                        <text fg={theme().fgMuted}>Endpoint: {env.otelEndpoint ?? "not set (OTEL_EXPORTER_OTLP_ENDPOINT)"}</text>
                                    </Show>
                                </box>
                            </box>
                        );
                    }}
                </For>

                <box id={`section-${THEME_SECTION}`} flexDirection="column" paddingLeft={2} paddingTop={1}>
                    <text fg={theme().fg}>{section() === THEME_SECTION ? <Reverse>theme</Reverse> : <Fg role="fgMuted">theme</Fg>}</text>
                    <For each={themeIds}>
                        {(id) => {
                            const isActive = () => draft().theme === id;
                            return (
                                <box paddingLeft={2}>
                                    <text fg={isActive() && section() === THEME_SECTION ? theme().secondary : isActive() ? theme().accent : theme().fg}>
                                        {isActive() ? `(${GLYPHS.circle})` : "( )"} {themes[id].name}
                                        {isActive() && saved().theme !== id ? " *" : ""}
                                    </text>
                                </box>
                            );
                        }}
                    </For>
                </box>

                <box id={`section-${RUNTIME_SECTION}`} flexDirection="column" paddingLeft={2} paddingTop={1}>
                    <text fg={theme().fg}>
                        {section() === RUNTIME_SECTION ? <Reverse>container runtime</Reverse> : <Fg role="fgMuted">container runtime</Fg>}
                    </text>
                    <For each={runtimeIds}>
                        {(id) => {
                            const isActive = () => draft().runtime === id;
                            return (
                                <box paddingLeft={2}>
                                    <text fg={isActive() && section() === RUNTIME_SECTION ? theme().secondary : isActive() ? theme().accent : theme().fg}>
                                        {isActive() ? `(${GLYPHS.circle})` : "( )"} {runtimes[id].label}
                                        {isActive() && saved().runtime !== id ? " *" : ""}
                                    </text>
                                </box>
                            );
                        }}
                    </For>
                </box>

                <For each={PG_FIELDS}>
                    {(field, i) => {
                        // eslint-disable-next-line solid/reactivity -- PG_FIELDS is static; the index is stable for the row's lifetime, so seeding-once is safe.
                        const fieldSection = PG_FIELD_SECTIONS_START + i();
                        const focused = () => section() === fieldSection;
                        const value = () => String(pgDraft()[field]);
                        const changed = () => pgDraft()[field] !== pgSaved()[field];
                        return (
                            <box id={`section-${fieldSection}`} flexDirection="column" paddingLeft={2} paddingTop={1}>
                                <text fg={theme().fg}>
                                    {focused() ? (
                                        <Reverse>
                                            {PG_FIELD_LABELS[field]}: {value()}
                                            {changed() ? " *" : ""}
                                        </Reverse>
                                    ) : (
                                        <Fg role="fgMuted">
                                            {PG_FIELD_LABELS[field]}: {value()}
                                            {changed() ? " *" : ""}
                                        </Fg>
                                    )}
                                </text>
                                <Show when={field === "password"}>
                                    <box paddingLeft={4}>
                                        <text fg={theme().fgMuted}>shown in clear text — local connection credential</text>
                                    </box>
                                </Show>
                                <box paddingLeft={4}>
                                    <text fg={theme().fgMuted}>press Enter to edit</text>
                                </box>
                            </box>
                        );
                    }}
                </For>
            </ScrollPane>

            <Show when={notice()}>
                <box paddingLeft={2} paddingTop={1}>
                    <text fg={noticeColor(notice()!.kind)}>{notice()!.text}</text>
                </box>
            </Show>

            <box paddingLeft={2} paddingTop={1}>
                <text fg={theme().fgMuted}>File: {env.configPath}</text>
            </box>

            {/* Standalone owns its renderer, so it mounts its own overlay for the pg-field
                 prompt; embedded reuses the chat App's (one DialogOverlay per renderer). */}
            <Show when={!props.onClose}>
                <DialogOverlay />
            </Show>
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
