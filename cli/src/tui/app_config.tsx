import { render, useRenderer } from "@opentui/solid";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { homedir } from "node:os";
import { basename } from "node:path";

import { readConfig, resolvePostgresConfig, writeConfig, type Config } from "../lib/config.ts";
import { env, isReservedPostgresPort } from "../lib/env.ts";
import { GLYPHS, themes, themeIds } from "../lib/design_system.ts";
import { shutdown } from "../lib/shutdown.ts";
import { setTheme, theme, noticeColor, type Notice } from "./theme.ts";
import { StatusBar } from "./layout/status_bar.tsx";
import { useKeymapRoot, KEYS, chordLabel } from "./keymap.ts";
import { DialogOverlay, dialogPush, dialogClose, useDialogBindings, useDialogClose, useDialogCloseGuard } from "./components/dialog/dialog_host.tsx";
import { Bold, Reverse, Fg } from "./components/emphasis.tsx";
import { PromptDialog } from "./components/dialog/prompt_dialog.tsx";
import { SelectDialog } from "./components/dialog/select_dialog.tsx";
import { FilePicker } from "./components/dialog/file_picker.tsx";
import { ScrollPane } from "./components/scroll_pane.tsx";
import { runtimes, runtimeIds } from "../lib/container.ts";
import { listEmbeddingModels } from "../modules/embedding/api_models.ts";
import { explicitPostgresFields } from "../modules/infra/setup.ts";
import { DEFAULT_API_BASE_URL, DEFAULT_API_EMBEDDING_DIMENSIONS } from "../modules/embedding/resolve.ts";
import { LOCAL_EMBEDDING_DIMENSIONS } from "../modules/embedding/local-provider.ts";

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
type Section =
    { kind: "toggle"; settingIndex: number } | { kind: "theme" } | { kind: "runtime" } | { kind: "postgres_field"; field: PgField } | { kind: "embedding" };

const PG_FIELDS = ["host", "port", "database", "user", "password"] as const;
type PgField = (typeof PG_FIELDS)[number];

const PG_FIELD_LABELS: Record<PgField, string> = {
    host: "host",
    port: "port",
    database: "database",
    user: "user",
    password: "password",
};

/**
 * What the embedding backend picker offers. `builtin` and `custom` both resolve to `mode: "local"` —
 * they differ only in which GGUF is used, which is the distinction the user actually thinks in (and the
 * one the old mode-only radio could not express).
 */
type EmbeddingChoice = "builtin" | "custom" | "api-key" | "off";

/**
 * One line describing the active backend for the settings row. NEVER prints the api key — it is a
 * remote secret and this row is always on screen (unlike the local postgres password, which is not).
 *
 * The embedding block is a mode-discriminated union, so a single summary is the honest rendering:
 * showing every `embedding.*` field at once would put a model path beside an api key beside a base url,
 * most of them inapplicable to the active backend.
 */
function embeddingSummary(e: Config["embedding"]): string {
    switch (e.mode) {
        case "off":
            return "off";
        case "api-key":
            return `api-key — ${e.model ?? "default model"} (${e.dimensions ?? DEFAULT_API_EMBEDDING_DIMENSIONS}-dim)`;
        case "local": {
            // An unset path means a config that never ran setup; it resolves to the built-in location,
            // so it reads as the built-in model rather than as a mystery custom one.
            const path = e.modelPath;
            if (path === undefined || path === env.embeddingModelPath) return `local — built-in bge-small (${LOCAL_EMBEDDING_DIMENSIONS}-dim)`;
            return `local — ${basename(path)} (${e.dimensions ?? LOCAL_EMBEDDING_DIMENSIONS}-dim)`;
        }
        default: {
            const _exhaustive: never = e.mode;
            void _exhaustive;
            return "off";
        }
    }
}

const sections: Section[] = [
    ...settings.map((_, i): Section => ({ kind: "toggle", settingIndex: i })),
    { kind: "theme" },
    { kind: "runtime" },
    ...PG_FIELDS.map((f): Section => ({ kind: "postgres_field", field: f })),
    { kind: "embedding" },
];
/** Section indices of the radio groups (the toggles occupy `0 … settings.length-1`). */
const THEME_SECTION = settings.length;
const RUNTIME_SECTION = settings.length + 1;
const PG_FIELD_SECTIONS_START = settings.length + 2;
const EMBEDDING_SECTION = PG_FIELD_SECTIONS_START + PG_FIELDS.length;

/** Upper bound on the api-key model probe. A hung endpoint must not keep the "Fetching models…" notice up: the abort trips this timeout, and the fetch then degrades to manual model-id entry like any other listing failure. */
const MODEL_FETCH_TIMEOUT_MS = 10_000;

export function ConfigApp(props: { onClose?: () => void }) {
    const renderer = useRenderer();
    // Read config once; saved and draft both start from it. Focus starts on the first
    // section (the telemetry toggle) — the top of the form — so every section, including
    // the toggles, is reachable by walking down from a fixed, predictable origin.
    // Seed postgres with resolved defaults so the form shows every field even when
    // config.json has no `postgres` key. These resolved defaults are NOT persisted verbatim —
    // save() filters the block to explicit non-default choices (see explicitPostgresFields).
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

    /** The draft's embedding block — guaranteed present (the schema defaults it to `{ mode: "off" }`). */
    const embDraft = () => draft().embedding;
    /** The saved embedding block — same default guarantee. */
    const embSaved = () => saved().embedding;
    /** Structural compare: a backend change replaces the whole block, so every field is in scope. */
    const embeddingChanged = () => {
        const a = embDraft();
        const b = embSaved();
        return (
            a.mode !== b.mode ||
            a.modelPath !== b.modelPath ||
            a.apiKey !== b.apiKey ||
            a.baseURL !== b.baseURL ||
            a.model !== b.model ||
            a.dimensions !== b.dimensions
        );
    };

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
        PG_FIELDS.some((f) => pgDraft()[f] !== pgSaved()[f]) ||
        embeddingChanged();

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
                const rt = draft().runtime;
                // Unset renders both radios empty; index -1 clamps so the first arrow
                // press lands on the registry's first entry instead of skipping it.
                const current = rt === undefined ? -1 : runtimeIds.indexOf(rt);
                const id = runtimeIds[Math.min(runtimeIds.length - 1, Math.max(0, current + delta))]!;
                setDraft({ ...draft(), runtime: id });
                break;
            }
            case "postgres_field": {
                break;
            }
            // Dialog-driven: there is no left/right axis to step. Enter opens the backend picker.
            case "embedding": {
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
                validate={(value) => validatePgField(field, value)}
                onSubmit={(value: string) => {
                    dialogClose();
                    setPgField(field, value);
                }}
                onCancel={() => {}}
            />
        ));
    }

    /**
     * In-dialog validation for a postgres field: non-empty everywhere, and for `port` a 1-65535 integer
     * that is NOT a reserved channel default. Returning a message re-asks in place (see PromptDialog), so
     * `setPgField` only ever applies a clean value.
     */
    function validatePgField(field: PgField, value: string): string | undefined {
        const trimmed = value.trim();
        if (field === "port") {
            const n = Number(trimmed);
            if (!Number.isInteger(n) || n <= 0 || n > 65535) return `"${trimmed}" is not a valid port number (1-65535).`;
            // 8432 (prod) / 8434 (dev) are the build channels' reserved default ports. config.json is shared
            // across channels, so resolvePostgresConfig ignores a reserved port at read time — accepting one
            // here would silently discard it. Reject it up front and say why.
            if (isReservedPostgresPort(n))
                return `${n} is a reserved default port (prod 8432 / dev 8434) that cannot be pinned in config.json — each channel resolves its own default automatically.`;
            return undefined;
        }
        return trimmed === "" ? "Value cannot be empty." : undefined;
    }

    // --- embedding: a backend picker plus per-backend follow-up dialogs -------------------------
    // Each step closes itself before pushing the next, so the dialog stack never grows with the chain.
    // Nothing touches the draft until the FINAL step of a branch, which is what makes cancelling any
    // step a clean abort: there is no partially-applied backend to unwind.

    // The api-key backend probes the user's endpoint for its model list. Track the in-flight probe's
    // controller so (a) re-entering the flow aborts the previous fetch, and (b) unmount aborts it — a
    // late resolution must never dialogPush / setNotice onto a screen the user has already left. The
    // continuation distinguishes "flow is dead" (disposed on unmount, or superseded by a newer probe →
    // run NOTHING) from a live timeout (the endpoint hung → degrade to manual entry).
    let modelFetchController: AbortController | null = null;
    let disposed = false;
    onCleanup(() => {
        disposed = true;
        modelFetchController?.abort();
    });

    /* eslint-disable solid/reactivity -- every callback in this block runs from a user-driven dialog
       submission, which the rule cannot see (it recognizes JSX handlers, not our promptField /
       promptDimensions / Result.match boundaries). Each draft read inside them is a deliberate
       point-in-time read of the value at the instant the user acted — seeding a prompt with the current
       setting, or composing the block to apply. Tracking them would be actively wrong: a chain already
       in flight must not re-run or re-seed because the draft changed underneath it. */

    /**
     * Replace the draft's embedding block wholesale rather than merging over the previous one: a switch
     * to `local` must not inherit the api key (and vice versa), or a stale field from the abandoned
     * backend would ride along in config.json and resurface if the user switched back.
     */
    function applyEmbedding(next: Config["embedding"]): void {
        setDraft({ ...draft(), embedding: next });
        setNotice(null);
        setQuitArmed(false);
    }

    /**
     * Push a single-field text prompt; the value is handed on trimmed by each caller as it needs. An
     * optional `validate` re-asks IN the dialog on a bad value (see PromptDialog), so `onSubmit` — which
     * still closes the dialog before running its continuation — only ever fires for a validated value.
     */
    function promptField(title: string, value: string, onSubmit: (value: string) => void, validate?: (value: string) => string | undefined): void {
        dialogPush(() => (
            <PromptDialog
                title={title}
                value={value}
                validate={validate}
                onSubmit={(v: string) => {
                    dialogClose();
                    onSubmit(v);
                }}
                onCancel={() => {}}
            />
        ));
    }

    /**
     * Collect a vector width. This screen cannot MEASURE one — only `inflexa setup` spawns the sidecar to
     * probe a model — so the user states it, and a wrong value is deliberately not guarded here (see
     * issue #164: a width that disagrees with an analysis's existing index fails at the pgvector upsert).
     */
    function promptDimensions(targetMode: "local" | "api-key", fallback: number, apply: (dimensions: number) => void): void {
        // Only carry the draft's width forward when the user is staying within the same backend family: a
        // 768-dim custom-GGUF draft must NOT pre-fill 768 into the api-key prompt (whose default is 1536),
        // and vice versa. A backend switch seeds the TARGET's own default instead.
        const seed = embDraft().mode === targetMode ? (embDraft().dimensions ?? fallback) : fallback;
        promptField(
            "Vector dimensions",
            String(seed),
            // Validated to a positive integer below, so the continuation always applies a clean width.
            (value) => apply(Number(value.trim())),
            (value) => {
                const trimmed = value.trim();
                const n = Number(trimmed);
                return !Number.isInteger(n) || n <= 0 ? `"${trimmed}" is not a valid dimension (a positive integer).` : undefined;
            },
        );
    }

    /** Browse for a GGUF, then its width. Opens at home: a model the user already has can live anywhere. */
    function openCustomGgufFlow(): void {
        dialogPush(() => (
            <FilePicker
                rootPath={homedir()}
                selectedPaths={new Set<string>()}
                confirmLabel="Use"
                requireSelection
                onConfirm={(paths: string[]) => {
                    dialogClose();
                    const path = paths[0];
                    if (path === undefined) return;
                    // Omit `dimensions` when it equals the built-in width — the local provider defaults to it,
                    // so recording it would only bloat config.json. Mirrors modules/embedding/setup.ts's branch.
                    promptDimensions("local", LOCAL_EMBEDDING_DIMENSIONS, (dimensions) =>
                        applyEmbedding({ mode: "local", modelPath: path, ...(dimensions === LOCAL_EMBEDDING_DIMENSIONS ? {} : { dimensions }) }),
                    );
                }}
                onCancel={() => {}}
            />
        ));
    }

    /** Key → base URL → (fetched model selection, or free-text on a failed listing) → width. */
    function openApiKeyFlow(): void {
        promptField(
            "embedding.apiKey",
            embDraft().apiKey ?? "",
            (rawKey) => {
                // Validated non-empty below, so the continuation always has a real key to carry forward.
                const apiKey = rawKey.trim();
                promptField("embedding.baseURL", embDraft().baseURL ?? DEFAULT_API_BASE_URL, (rawUrl) => {
                    const baseURL = rawUrl.trim() === "" ? DEFAULT_API_BASE_URL : rawUrl.trim();
                    setNotice({ kind: "info", text: `Fetching models from ${baseURL}…` });
                    // Supersede any prior in-flight probe, then bound this one so a hung endpoint aborts.
                    modelFetchController?.abort();
                    const controller = new AbortController();
                    modelFetchController = controller;
                    const timer = setTimeout(() => controller.abort(), MODEL_FETCH_TIMEOUT_MS);
                    void listEmbeddingModels(baseURL, apiKey, controller.signal).then((result) => {
                        clearTimeout(timer);
                        // Unmounted, or a newer probe replaced this one → the flow this continuation targets is
                        // gone; run NOTHING (no setNotice / dialogPush / promptField onto a dead screen). A live
                        // timeout leaves both checks false, so it falls through to the failure branch below.
                        if (disposed || modelFetchController !== controller) return;
                        modelFetchController = null;
                        result.match(
                            (ids) => {
                                setNotice(null);
                                dialogPush(() => (
                                    <SelectDialog<string>
                                        title="Embedding model"
                                        emptyText="No embedding models matched"
                                        items={ids.map((id) => ({ value: id, title: id }))}
                                        onSelect={(id: string) => {
                                            dialogClose();
                                            finishApiKey(apiKey, baseURL, id);
                                        }}
                                        onCancel={() => {}}
                                    />
                                ));
                            },
                            // Every listing failure degrades the same way, so they share one branch: an endpoint
                            // that is offline, gates /models, times out, or names its models unconventionally is
                            // still configurable by typing the id.
                            () => {
                                setNotice({ kind: "warn", text: "Could not list models from that endpoint — enter the model id manually." });
                                promptField("embedding.model", embDraft().model ?? "", (model) => finishApiKey(apiKey, baseURL, model.trim()));
                            },
                        );
                    });
                });
            },
            (value) => (value.trim() === "" ? "An API key is required for api-key mode." : undefined),
        );
    }

    /** The shared tail of both api-key paths: width, then apply. An empty model defers to the harness default. */
    function finishApiKey(apiKey: string, baseURL: string, model: string): void {
        promptDimensions("api-key", DEFAULT_API_EMBEDDING_DIMENSIONS, (dimensions) =>
            // Omit `dimensions` when it equals the api-key default width — resolve.ts passes it straight
            // through and the harness provider falls back to the same 1536 regardless of model, so recording
            // it would only bloat config.json. Mirrors the custom-GGUF branch's built-in-width omission.
            applyEmbedding({
                mode: "api-key",
                apiKey,
                baseURL,
                ...(model === "" ? {} : { model }),
                ...(dimensions === DEFAULT_API_EMBEDDING_DIMENSIONS ? {} : { dimensions }),
            }),
        );
    }

    function startBackendFlow(choice: EmbeddingChoice): void {
        switch (choice) {
            case "builtin":
                // The built-in model needs no input: its path is env-managed and its width is fixed, so
                // recording no `dimensions` lets the provider's own default apply.
                applyEmbedding({ mode: "local", modelPath: env.embeddingModelPath });
                break;
            case "off":
                applyEmbedding({ mode: "off" });
                break;
            case "custom":
                openCustomGgufFlow();
                break;
            case "api-key":
                openApiKeyFlow();
                break;
            default: {
                const _exhaustive: never = choice;
                void _exhaustive;
            }
        }
    }

    function openEmbeddingPicker(): void {
        dialogPush(() => (
            <SelectDialog<EmbeddingChoice>
                title="Embedding backend"
                emptyText="No backends"
                items={[
                    {
                        value: "builtin",
                        title: "Built-in model",
                        description: `bge-small-en-v1.5 — ${LOCAL_EMBEDDING_DIMENSIONS}-dim, bundled, no API key or network`,
                    },
                    { value: "custom", title: "Your own GGUF", description: "Pick a local model file you already have" },
                    { value: "api-key", title: "API key", description: "A remote OpenAI-compatible embeddings endpoint" },
                    { value: "off", title: "Off", description: "Disable embeddings" },
                ]}
                onSelect={(choice: EmbeddingChoice) => {
                    dialogClose();
                    startBackendFlow(choice);
                }}
                onCancel={() => {}}
            />
        ));
    }

    /* eslint-enable solid/reactivity */

    // Applies a value already cleared by validatePgField: `port` is a valid, non-reserved integer; every
    // other field is a non-empty trimmed string.
    function setPgField(field: PgField, value: string): void {
        const trimmed = value.trim();
        const applied = field === "port" ? { port: Number(trimmed) } : { [field]: trimmed };
        setDraft({ ...draft(), postgres: { ...pgDraft(), ...applied } });
        setNotice(null);
        setQuitArmed(false);
    }

    function save() {
        if (!dirty()) {
            setNotice({ kind: "info", text: "No changes to save." });
            return;
        }
        const next = draft();
        // config.json is shared by both build channels, so a postgres field the user merely ACCEPTED at its
        // channel default must not be frozen into the file — that would override the other channel's sibling
        // default and re-create the port collision explicitPostgresFields exists to prevent. Persist only the
        // fields that differ from their defaults; an all-defaults result drops the `postgres` key entirely
        // (JSON.stringify omits an `undefined` value). saved() still holds the FULL resolved draft so the
        // on-screen form keeps every field populated — mirroring how setup returns the full connection for
        // this-run use but persists only the filtered block.
        const explicit = explicitPostgresFields(pgDraft());
        const persisted = Object.keys(explicit).length === 0 ? undefined : explicit;
        writeConfig({ ...next, postgres: persisted }).match(
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
                    else if (s.kind === "embedding") openEmbeddingPicker();
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

                <box id={`section-${EMBEDDING_SECTION}`} flexDirection="column" paddingLeft={2} paddingTop={1}>
                    <text fg={theme().fg}>
                        {section() === EMBEDDING_SECTION ? (
                            <Reverse>
                                embedding: {embeddingSummary(embDraft())}
                                {embeddingChanged() ? " *" : ""}
                            </Reverse>
                        ) : (
                            <Fg role="fgMuted">
                                embedding: {embeddingSummary(embDraft())}
                                {embeddingChanged() ? " *" : ""}
                            </Fg>
                        )}
                    </text>
                    <box paddingLeft={4}>
                        <text fg={theme().fgMuted}>press Enter to choose a backend</text>
                    </box>
                </box>
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
