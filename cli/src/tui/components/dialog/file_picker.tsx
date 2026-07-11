import { readdirSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { ok, err, type Result } from "neverthrow";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { InputRenderable } from "@opentui/core";

import { GLYPHS, space } from "../../../lib/design_system.ts";
import { theme } from "../../theme.ts";
import { KEYS, chordLabel, type Chord } from "../../keymap.ts";
import { statResult } from "../../../lib/fs.ts";
import { canonicalPath } from "../../../modules/anchor/marker.ts";
import { openInFileBrowser } from "../../../modules/analysis/open.ts";
import { notify } from "../../hooks/notice.ts";
import { useDialogBindings, useDialogCancel, useDialogCloseGuard } from "./dialog_host.tsx";
import { DialogPanel } from "./dialog_panel.tsx";
import { TextInput } from "../text_input.tsx";
import { DynamicList } from "../dynamic_list.tsx";
import { Bold } from "../emphasis.tsx";
import type { SelectItem } from "../list_core.tsx";

// A navigable, multi-select file browser on DynamicList: a `readdirSync` listing re-minted per
// navigation (the textbook DynamicList source), a fuzzy filter within the current folder, and
// space-to-toggle selection that survives navigation because values are canonical ABSOLUTE paths,
// not row objects. Two callers seed it differently (new-analysis seeds empty; add-inputs seeds
// the analysis's existing inputs), so it lives in `components/` per the ≥2-callers rule.
//
// Domain work (path classification, anchor-riding, dedup) is owned by the caller's WRITE path:
// the picker hands a flat absolute string[] back and imports nothing from `modules/analysis/`
// except `openerArgv` — that and `canonicalPath` are leaf-ish, render-free helpers (the same
// class of exception as `chat.tsx` reaching for the marker grammar), which is what lets the
// widget keep its `components/` home.
//
// Keyboard model — INSERT / NORMAL, mirroring the app's pattern:
//   INSERT (filter input focused): keys type into the filter; ↑/↓ + ctrl+p/n still move the
//     cursor and enter still descends/confirms (no collision with typing); esc BLURS to NORMAL —
//     via the dialog close-guard veto, since content dialogs never bind esc themselves.
//   NORMAL (input blurred — the mount default): space toggles, enter descends into a dir or
//     confirms the batch from a file row, `c` confirms regardless of the cursor (the only
//     confirm reachable when every visible row is a directory), ←/→ ascend/descend, `i` filter,
//     `a` hidden files, `s` review the selection, `o` open in the OS explorer, esc cancels.
//   REVIEW (`s`): the browse view swaps for a list of the selected paths; enter removes one,
//     esc returns to browsing. The swap unmounts the browse list, so on return it remounts
//     seeded from the picker's selection mirror — that remount is what lets review edit a
//     selection the list otherwise owns internally.

/**
 * The picker's NORMAL-mode chords: the single source for each binding AND its footer label
 * (via {@link chordLabel}), so the two can never drift. Not in the shared `KEYS` — these are
 * picker-vocabulary keys, not structural navigation.
 */
const PICKER_KEYS = {
    filter: { key: "i" },
    hidden: { key: "a" },
    review: { key: "s" },
    explorer: { key: "o" },
    // Confirm regardless of the cursor row: enter is overloaded (a dir row descends), so a
    // listing whose every row is a directory would otherwise offer no way to hand the batch back.
    confirm: { key: "c" },
} as const satisfies Record<string, Chord>;

/** A disk row. `..` is synthesized upstream of these so it never collides with a real entry. */
type Row = { name: string; isDir: boolean; abs: string };

/** Props for {@link FilePicker}. All paths are absolute; the caller owns the browse root. */
export type FilePickerProps = {
    /** Where browsing opens. Absolute; the caller ensured it exists. */
    rootPath: string;
    /** Absolute paths to render pre-checked (canonicalized on intake — see the seed comment). */
    selectedPaths: ReadonlySet<string>;
    /** Confirm verb surfaced in the footer hint (e.g. `"Create"` vs `"Add"`). */
    confirmLabel: string;
    /**
     * When true, an empty confirm is refused (warning notice, picker stays open). New-analysis
     * sets this — the picker exists to break the old silent whole-cwd default. Add-inputs leaves
     * it off: clearing every input is a legitimate state.
     */
    requireSelection?: boolean;
    /** Called with the final selection (absolute paths) on confirm. The caller closes the dialog. */
    onConfirm: (absolutePaths: string[]) => void;
    /** Wired to every non-commit close of the dialog. */
    onCancel: () => void;
};

/**
 * The current dir, dirs-first then files, each group alphabetical (case-insensitive). The err
 * channel is the human-readable message (permission, broken mount): the caller renders it as the
 * list's error line and the user ascends — a single unreadable folder must not abort the picker.
 */
function listDir(dir: string, hideHidden: boolean): Result<Row[], string> {
    let entries: Dirent[];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch (cause) {
        return err(cause instanceof Error ? cause.message : String(cause));
    }
    const rows: Row[] = [];
    for (const e of entries) {
        if (hideHidden && e.name.startsWith(".")) continue;
        // `withFileTypes` carries the classification straight off the dirent — one readdir, not
        // N stats. A symlink-to-dir browses as a folder (node_modules/* is often a symlink).
        // Symlink rows carry their CANONICAL target as the value: the selection space is
        // canonical (classifyInputPath stores realpaths, the seed re-canonicalizes), so an
        // uncanonical row would render a recorded input unchecked. canonicalPath degrades to
        // the textual path for broken links, which then classify as file rows.
        const raw = resolve(dir, e.name);
        const abs = e.isSymbolicLink() ? canonicalPath(raw) : raw;
        const isDir = e.isDirectory() || (e.isSymbolicLink() && safeSymlinkIsDir(abs));
        rows.push({ name: e.name, isDir, abs });
    }
    rows.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.isDir ? -1 : 1));
    return ok(rows);
}

// Best-effort: a broken symlink (target gone) must not crash the listing — it degrades to a file
// row, the safe non-browsable choice. `abs` is already canonical (listDir resolved it).
function safeSymlinkIsDir(abs: string): boolean {
    return statResult(abs, "filePicker:symlinkStat").match(
        (s) => s.isDirectory(),
        () => false,
    );
}

/** The cwd tail, segment-collapsed when deep — head + tail always shown, mid-segments ellipsized. */
function breadcrumbSegments(dir: string): string[] {
    if (!isAbsolute(dir)) return [dir];
    const parts = dir.split(sep).filter(Boolean);
    if (parts.length <= 4) return parts;
    return [parts[0]!, parts[1]!, GLYPHS.ellipsis, ...parts.slice(-2)];
}

export function FilePicker(props: FilePickerProps): JSX.Element {
    /* eslint-disable solid/reactivity -- seed-once: the picker mounts once with fixed props */
    const [cwd, setCwd] = createSignal(canonicalPath(props.rootPath));
    // Seed paths are canonicalized here so membership checks match the rows `listDir` constructs
    // (`resolve` of a canonical cwd) — an uncanonicalized `/var/...` seed on macOS would silently
    // miss its `/private/var/...` row. The picker owns this because only it knows its row keys.
    const seedSelected: ReadonlySet<string> = new Set([...props.selectedPaths].map(canonicalPath));
    /* eslint-enable solid/reactivity */

    // Mirror of the browse list's live selection (fed by onSelectionChange). The list owns the
    // set while browsing; the picker needs it for the footer count, for review mode, and as the
    // seed when the browse list REMOUNTS after review.
    const [selected, setSelected] = createSignal<ReadonlySet<string>>(seedSelected);
    const [inputFocused, setInputFocused] = createSignal(false);
    const [hideHidden, setHideHidden] = createSignal(true);
    const [review, setReview] = createSignal(false);
    const [query, setQuery] = createSignal("");
    const [cursorAbs, setCursorAbs] = createSignal<string | undefined>(undefined);
    let inputRef: InputRenderable | null = null;

    const listed = createMemo(() => listDir(cwd(), hideHidden()));
    const rows = (): Row[] => listed().unwrapOr([]);
    const listError = (): string | null =>
        listed().match(
            () => null,
            (e) => e,
        );
    const parentAbs = (): string => dirname(cwd());

    // `..` is synthesized ahead of the rows (never read from disk, so it can't collide with a
    // real entry). It is a navigation affordance, not a match target: a non-empty filter hides
    // it, and an unreadable dir drops it so the error surfaces as the list's empty state (← still
    // ascends). Dir titles carry a trailing `/` — the type marker that needs no color.
    const items = createMemo<SelectItem<string>[]>(() => {
        const out: SelectItem<string>[] = [];
        if (query().trim() === "" && listError() === null) out.push({ value: parentAbs(), title: ".." });
        for (const r of rows()) out.push({ value: r.abs, title: r.isDir ? `${r.name}/` : r.name });
        return out;
    });

    function isDirRow(abs: string): boolean {
        return abs === parentAbs() || (rows().find((r) => r.abs === abs)?.isDir ?? false);
    }
    function intoDir(abs: string): void {
        setCwd(canonicalPath(abs));
        setQuery("");
        if (inputRef) inputRef.value = "";
    }
    function handleAction(abs: string): boolean {
        if (isDirRow(abs)) {
            intoDir(abs);
            return true;
        }
        return false;
    }
    function handleConfirm(values: string[]): void {
        // Refusing the empty confirm is the new-analysis flow's whole point: the OLD in-TUI flow
        // silently defaulted the input set to the entire cwd.
        if (props.requireSelection && values.length === 0) {
            notify({ kind: "warn", text: "Select at least one entry (space to toggle)." });
            return;
        }
        // The selection may include paths from dirs the user toggled then walked away from —
        // that is the point of multi-select-then-browse. Hand it through untouched; the caller's
        // write path classifies each path.
        props.onConfirm([...values]);
    }
    function openExplorer(): void {
        const abs = cursorAbs();
        const dir = abs === undefined ? cwd() : isDirRow(abs) ? abs : dirname(abs);
        openInFileBrowser(dir).match(
            () => notify({ kind: "info", text: `Opened ${dir}` }),
            () => notify({ kind: "error", text: "No system file browser available." }),
        );
    }

    // Review rows: root-relative when inside the picker's root so paths from different subdirs
    // are distinguishable without repeating the common ancestor on every line.
    const reviewItems = createMemo<SelectItem<string>[]>(() => {
        const root = canonicalPath(props.rootPath);
        return [...selected()].sort().map((abs) => ({
            value: abs,
            title: abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs,
        }));
    });
    function removeSelected(abs: string): void {
        const next = new Set(selected());
        next.delete(abs);
        setSelected(next);
        if (next.size === 0) setReview(false);
    }

    useDialogCancel(() => props.onCancel());
    // The layered esc, WITHOUT binding esc (the host owns it): vetoing the cancel-close is the
    // sanctioned way to consume one esc press per mode transition — REVIEW → browse, INSERT →
    // NORMAL, and only a NORMAL esc actually cancels.
    useDialogCloseGuard((reason) => {
        if (reason !== "cancel") return true;
        if (review()) {
            setReview(false);
            return false;
        }
        if (inputFocused()) {
            inputRef?.blur();
            return false;
        }
        return true;
    });

    // NORMAL-mode keys. Bare printables are compliant here: the layer is enabled only while no
    // editor holds focus (and suspends entirely during review, whose list owns the keyboard).
    const normal = (): boolean => !inputFocused() && !review();
    useDialogBindings(() => ({
        enabled: normal(),
        bindings: [
            { chord: KEYS.left, run: () => intoDir(parentAbs()), desc: "Parent folder", group: "File picker" },
            {
                chord: KEYS.right,
                run: () => {
                    const abs = cursorAbs();
                    if (abs !== undefined && isDirRow(abs)) intoDir(abs);
                },
                desc: "Enter folder",
                group: "File picker",
            },
            { chord: PICKER_KEYS.filter, run: () => inputRef?.focus(), desc: "Filter", group: "File picker" },
            { chord: PICKER_KEYS.hidden, run: () => setHideHidden((h) => !h), desc: "Toggle hidden files", group: "File picker" },
            {
                chord: PICKER_KEYS.review,
                run: () => {
                    if (selected().size === 0) {
                        notify({ kind: "warn", text: "No files selected." });
                        return;
                    }
                    setQuery(""); // the browse TextInput remounts empty after review; keep the filter state in step
                    setReview(true);
                },
                desc: "Review selection",
                group: "File picker",
            },
            { chord: PICKER_KEYS.explorer, run: openExplorer, desc: "Open in explorer", group: "File picker" },
            {
                chord: PICKER_KEYS.confirm,
                run: () => handleConfirm([...selected()]),
                desc: "Confirm selection",
                group: "File picker",
            },
        ],
    }));

    function footer(): string {
        const sep = ` ${GLYPHS.middot} `;
        const sel = selected().size;
        const count = sel === 0 ? "none selected" : `${sel} selected`;
        if (review()) return ["REVIEW", `${chordLabel(KEYS.enter)} remove`, `${chordLabel(KEYS.escape)} back`, count].join(sep);
        if (inputFocused()) return ["INSERT", `${chordLabel(KEYS.up)}/${chordLabel(KEYS.down)} move`, `${chordLabel(KEYS.escape)} normal`, count].join(sep);
        return [
            "NORMAL",
            `${chordLabel(KEYS.space)} toggle`,
            `${chordLabel(KEYS.enter)} open`,
            `${chordLabel(PICKER_KEYS.confirm)} ${props.confirmLabel.toLowerCase()}`,
            `${chordLabel(PICKER_KEYS.hidden)} ${hideHidden() ? "show" : "hide"} hidden`,
            `${chordLabel(PICKER_KEYS.review)} review`,
            `${chordLabel(PICKER_KEYS.explorer)} explorer`,
            `${chordLabel(PICKER_KEYS.filter)} filter`,
            `${chordLabel(KEYS.escape)} cancel`,
            count,
        ].join(sep);
    }

    const breadcrumb = createMemo(() => breadcrumbSegments(cwd()));

    return (
        <DialogPanel title="Select input files" size="lg" footer={footer()}>
            <Show
                when={!review()}
                fallback={
                    <>
                        <box width="100%" flexShrink={0} paddingBottom={space.sm}>
                            <text fg={theme().fgMuted}>
                                Selected ({selected().size}) {GLYPHS.middot} {chordLabel(KEYS.enter)} removes an entry
                            </text>
                        </box>
                        <DynamicList items={reviewItems()} emptyText="No files selected" onSelect={removeSelected} />
                    </>
                }
            >
                {/* The breadcrumb is one <text> with emphasis SPANS inside (never a nested block
                    <text>); the LAST segment is bolded so the user's location reads first. */}
                <box width="100%" flexShrink={0} flexDirection="row" paddingBottom={space.sm}>
                    <text fg={theme().fgMuted}>
                        <For each={breadcrumb()}>
                            {(seg, i) => (
                                <>
                                    {i() > 0 ? ` ${GLYPHS.chevronRight} ` : ""}
                                    {i() === breadcrumb().length - 1 ? <Bold>{seg}</Bold> : seg}
                                </>
                            )}
                        </For>
                    </text>
                </box>
                <TextInput
                    chrome="bare"
                    autoFocus={false}
                    placeholder={`Filter in this folder${GLYPHS.ellipsis}`}
                    onRef={(r: InputRenderable) => {
                        inputRef = r;
                    }}
                    onFocusChange={setInputFocused}
                    onInput={setQuery}
                />
                <DynamicList
                    items={items()}
                    query={query()}
                    emptyText={query().trim() === "" ? "Empty folder" : "No matches"}
                    errorText={listError()}
                    mode="multi"
                    initialSelected={selected()}
                    canToggle={(abs) => abs !== parentAbs()}
                    onAction={handleAction}
                    onConfirm={handleConfirm}
                    onSelectionChange={setSelected}
                    onCursorChange={setCursorAbs}
                    bareKeysEnabled={!inputFocused()}
                />
            </Show>
        </DialogPanel>
    );
}
