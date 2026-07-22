import { getColumns, GroupMultiSelectPrompt } from "@clack/core";
import {
    isCI,
    isCancel,
    isTTY,
    limitOptions,
    log,
    progress,
    S_BAR,
    S_BAR_END,
    S_BAR_H,
    S_CHECKBOX_ACTIVE,
    S_CHECKBOX_INACTIVE,
    S_CHECKBOX_SELECTED,
    S_CORNER_BOTTOM_LEFT,
    S_CORNER_BOTTOM_RIGHT,
    S_CORNER_TOP_LEFT,
    S_CORNER_TOP_RIGHT,
    symbol,
} from "@clack/prompts";
import { REFERENCE_DATA_CATALOG, type ReferenceDataCatalog } from "@inflexa-ai/harness";
import { err, ok, type Result } from "neverthrow";
import { stripVTControlCharacters, styleText } from "node:util";

import { confirm } from "../../lib/cli.ts";
import { env } from "../../lib/env.ts";
import {
    buildReferenceListDocument,
    buildReferenceVerifyDocument,
    ensureReferenceStore,
    inspectReferenceStore,
    installReferenceDatasets,
    referenceDownloadEstimate,
    verifyReferenceDatasets,
    type ReferenceDownloadEstimate,
    type ReferenceDownloadProgress,
    type ReferenceInstallOutcome,
    type ReferenceCatalogSource,
    type ReferenceProvisionError,
    type ReferenceStoreInspection,
} from "./store.ts";

/** Options shared by the explicit download command and setup. */
export type ReferenceDownloadOptions = {
    /** Selected catalog ids. */
    readonly ids: readonly string[];
    /** Explicit non-interactive consent and interactive confirmation bypass. */
    readonly yes?: boolean;
    /** Re-fetch even when the active install is intact; the only way to refresh a mutable upstream. */
    readonly force?: boolean;
    /** Whether terminal prompts may be used. */
    readonly interactive?: boolean;
    /** Matching catalog/plan seam for offline tests. */
    readonly source?: ReferenceCatalogSource;
    /** Confirmation seam for text-command tests; defaults to the shared terminal prompt. */
    readonly confirmDownload?: (question: string) => Promise<boolean>;
};

/** Setup-specific reference selection. */
export type ReferenceSetupOptions = {
    /** Explicit ids from `setup --refs`; absent means offer interactively (or default to recommended when headless). */
    readonly ids?: readonly string[];
    /** Explicit consent for a scripted transfer. */
    readonly yes?: boolean;
    /** Whether setup is attached to an interactive terminal. */
    readonly interactive: boolean;
    /** Matching catalog/plan seam for offline tests, mirroring the download path. */
    readonly source?: ReferenceCatalogSource;
};

/** A selection was cancelled before transfer. */
export type DeclinedReferenceDownload = {
    /** No dataset was activated. */
    readonly installed: readonly [];
    /** Distinguishes cancellation from an empty successful plan. */
    readonly declined: true;
};

/** Parse a comma-separated setup selection into stable, non-empty ids. */
export function parseReferenceIds(value: string | undefined): readonly string[] | undefined {
    if (value === undefined) return undefined;
    return [
        ...new Set(
            value
                .split(",")
                .map((id) => id.trim())
                .filter(Boolean),
        ),
    ];
}

/** A file count phrased for the terminal — the catalog pins no sizes, so the upstream determines
 * the bytes at download time and the honest thing to state ahead of time is the number of files. */
function formatFileCount(count: number): string {
    return `${count} file${count === 1 ? "" : "s"} of upstream-determined size`;
}

function formatDatasetSize(dataset: ReferenceDataCatalog["datasets"][number]): string {
    return formatFileCount(dataset.artifacts.length);
}

function renderError(error: ReferenceProvisionError): string {
    return error.message;
}

function renderEstimate(estimate: ReferenceDownloadEstimate): string {
    return formatFileCount(estimate.artifactsToFetch);
}

/** One catalog dataset, as the rest of this file talks about it. */
export type ReferenceDatasetEntry = ReferenceDataCatalog["datasets"][number];

/** Heading of the note that sits beside the picker. */
const ON_DEMAND_REFERENCE_TITLE = "No rush";

/**
 * How to get references later, as unwrapped paragraphs — the note is laid out twice at two different
 * widths (beside the list, or above it on a narrow terminal), so the copy is stored once and wrapped
 * at render time rather than hand-broken for one of them.
 *
 * Both routes are real: `refs download` is a registered command, and it is classified `approval` in
 * the command registry, so the conversation agent can propose exactly that argv through `run_inflexa`
 * and the user approves it in chat. The agent offers the download — it never performs one unattended,
 * and the wording promises nothing more than that.
 */
const ON_DEMAND_REFERENCE_BLOCKS: readonly string[] = [
    "Reference data is only needed once an analysis asks for it, so taking none now is a real choice — not a skipped step.",
    "Add any of them whenever you like:",
    "  inflexa refs download <id>",
    "Or just say what you need in chat: the agent works out which dataset that is and asks you to approve the download.",
];

/** Greedy wrap to `width` columns. Any block already narrow enough is emitted untouched, which is
 * what keeps the command line above from being reflowed into the prose around it. */
function wrapBlock(text: string, width: number): readonly string[] {
    if (text.length <= width) return [text];
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(" ")) {
        if (line.length === 0) line = word;
        else if (line.length + 1 + word.length <= width) line += ` ${word}`;
        else {
            lines.push(line);
            line = word;
        }
    }
    if (line.length > 0) lines.push(line);
    return lines;
}

/** The note as prose wrapped to `width`, with a blank line between paragraphs. */
export function onDemandReferenceNote(width: number): readonly string[] {
    return ON_DEMAND_REFERENCE_BLOCKS.flatMap((block, index) => [...(index === 0 ? [] : [""]), ...wrapBlock(block, width)]);
}

/**
 * The note as a bordered panel `width` columns wide inside its border, ready to be painted down the
 * right-hand side of the picker. Returned unstyled so the layout is assertable as plain text; the
 * renderer colours it, relying on every interior line starting and ending with a border glyph.
 */
export function onDemandReferencePanel(width: number): readonly string[] {
    const head = `${S_BAR_H} ${ON_DEMAND_REFERENCE_TITLE} `;
    const blank = `${S_BAR}${" ".repeat(width)}${S_BAR}`;
    return [
        `${S_CORNER_TOP_LEFT}${head}${S_BAR_H.repeat(Math.max(0, width - head.length))}${S_CORNER_TOP_RIGHT}`,
        blank,
        ...onDemandReferenceNote(width - 4).map((line) => `${S_BAR}  ${line.padEnd(width - 2)}${S_BAR}`),
        blank,
        `${S_CORNER_BOTTOM_LEFT}${S_BAR_H.repeat(width)}${S_CORNER_BOTTOM_RIGHT}`,
    ];
}

/**
 * The note as one prose string, for the terminals too narrow to float it beside the list. Wrapped a
 * little under the 80-column floor so the guide bars clack prefixes it with still fit.
 */
export const ON_DEMAND_REFERENCE_NOTE = onDemandReferenceNote(74).join("\n");

/**
 * The bulk-selection keys. Each replaces the selection outright, which is what makes the picker
 * viable as the only selection surface: reaching a large set costs one keystroke, and so does
 * abandoning one. Letters are free — the only keys clack reserves beyond navigation are vim's
 * `k`/`j`/`h`/`l` (`settings.aliases`), and this prompt has no type-ahead to compete with.
 */
const PICKER_KEY_ALL = "a";
const PICKER_KEY_NONE = "n";
const PICKER_KEY_RECOMMENDED = "r";

/** Prompt title, shared by the picker and the tests that assert on its frame. */
const PICKER_MESSAGE = "Reference datasets to download";

/** Visible columns of the guide clack draws to the left of every prompt line (`S_BAR` plus two). */
const PICKER_RAIL_COLUMNS = 3;
/** Content columns inside the floating note's border. */
const PICKER_PANEL_WIDTH = 40;
/** Blank columns between the longest listing row and the note's left border. */
const PICKER_PANEL_GAP = 4;
/** Listing columns the note refuses to squeeze below; under this it is printed above the list instead. */
const PICKER_PANEL_MIN_LIST = 56;

/**
 * Whether a terminal `columns` wide can carry the note beside the listing rather than above it.
 * Floating it is the better read — the note stays visible while scrolling and costs no vertical
 * space — but only while the listing keeps enough width to state a dataset's title and file count on
 * one line. Below that the note goes back above the list, where narrowness costs nothing.
 */
export function referenceNoteFloats(columns: number): boolean {
    return columns >= PICKER_RAIL_COLUMNS + PICKER_PANEL_MIN_LIST + PICKER_PANEL_GAP + PICKER_PANEL_WIDTH + 2;
}

/** One dataset row in the picker. */
export type ReferencePickerEntry = {
    /** Catalog id — the only thing the picker returns. */
    readonly value: string;
    /** Row text: the dataset's title and what it costs to fetch. */
    readonly label: string;
    /** Parenthesised annotation, when the dataset carries one. */
    readonly hint?: string;
};

/** Everything the picker renders from and every bulk key resolves against. */
export type ReferencePickerModel = {
    /** Catalog group label to its offered datasets, both in catalog order. */
    readonly groups: Readonly<Record<string, readonly ReferencePickerEntry[]>>;
    /** Every offered id — what the select-everything key selects. */
    readonly everything: readonly string[];
    /** The recommended ids among them; empty when nothing offered carries a recommendation. */
    readonly recommended: readonly string[];
    /** The key legend under the list, annotated when the recommended key has nothing to select. */
    readonly footer: string;
};

/**
 * Build the picker's contents for the datasets `catalog` is offering, with `withheld` naming what the
 * caller kept out of it — already installed and intact — so the legend can account for a recommended
 * key that has nothing left to select.
 *
 * Grouping is purely presentational — the catalog already carries `recommendation.group` per dataset
 * — and group insertion order follows first appearance, which is catalog order. Toggling a group
 * header selects every dataset under it; clack returns only the leaf ids, never the group label, so
 * the strict resolver downstream never sees a phantom id.
 */
export function referencePickerModel(catalog: ReferenceDataCatalog, withheld: readonly ReferenceDatasetEntry[] = []): ReferencePickerModel {
    const groups: Record<string, ReferencePickerEntry[]> = {};
    for (const dataset of catalog.datasets) {
        (groups[dataset.recommendation.group] ??= []).push({
            value: dataset.id,
            // A bare file count, not the "of upstream-determined size" phrasing the listing and the
            // consent line carry: repeated down a list this long it wraps rows and says nothing the
            // one place it matters — the plan shown before consent — does not already say.
            label: `${dataset.title} (${dataset.artifacts.length} file${dataset.artifacts.length === 1 ? "" : "s"})`,
            ...(dataset.recommendation.recommended ? { hint: "recommended" } : {}),
        });
    }
    const recommended = catalog.datasets.filter((dataset) => dataset.recommendation.recommended).map((dataset) => dataset.id);
    // The recommended key stays in the legend even when it can select nothing, annotated instead of
    // hidden: an offered set with no recommendation is the ordinary consequence of having installed
    // the recommended datasets already, and silently dropping the option is precisely what made that
    // successful state read as a missing feature. The annotation names that cause where it applies —
    // "already installed" answers the question "so where did they go?", which "none offered" leaves
    // hanging — and falls back to the neutral wording only when the offer genuinely has none to give.
    const installedRecommended = withheld.filter((dataset) => dataset.recommendation.recommended).length;
    const recommendedNote = recommended.length > 0 ? "" : installedRecommended > 0 ? ` (${installedRecommended} already installed)` : " (none offered)";
    const recommendedKey = `${PICKER_KEY_RECOMMENDED} recommended${recommendedNote}`;
    return {
        groups,
        everything: catalog.datasets.map((dataset) => dataset.id),
        recommended,
        footer: `↑/↓ move · space toggle · ${PICKER_KEY_ALL} all · ${recommendedKey} · ${PICKER_KEY_NONE} none · enter confirm`,
    };
}

/**
 * Resolve one keystroke into the selection it establishes, or `undefined` when the key is not a bulk
 * action and the picker's own handling should stand.
 *
 * The recommended key is inert rather than empty when nothing offered is recommended. A key labelled
 * "recommended" that wipes the selection is a trap, and "select none" already has its own key, so
 * the honest reading of "there is nothing to recommend here" is that the key does nothing.
 */
export function referencePickerBulkSelection(char: string | undefined, model: ReferencePickerModel): readonly string[] | undefined {
    switch (char?.toLowerCase()) {
        case PICKER_KEY_ALL:
            return model.everything;
        case PICKER_KEY_NONE:
            return [];
        case PICKER_KEY_RECOMMENDED:
            return model.recommended.length === 0 ? undefined : model.recommended;
        default:
            return undefined;
    }
}

/**
 * What the listing is leaving out, as lines to print above it. Why the recommended key may have
 * nothing to select is deliberately *not* repeated here — the legend annotates that key directly,
 * which is where someone looking for the missing option is already looking.
 */
export function referenceSelectionDisclosure(withheld: readonly ReferenceDatasetEntry[]): readonly string[] {
    if (withheld.length === 0) return [];
    return [`${withheld.length} dataset${withheld.length === 1 ? " is" : "s are"} already installed and intact — not listed below.`];
}

/**
 * Paint `panel` down the right of `rows`, every row padded to the same `gutter` column so the note's
 * left edge holds still while the listing scrolls underneath it. Rows are extended when the panel is
 * the taller of the two, which keeps the box closed on an offer of only a few datasets.
 *
 * Padding is measured on the stripped text because the rows carry colour: their `.length` counts
 * escape bytes the terminal never draws, and padding to that would step the panel left row by row.
 */
function beside(rows: readonly string[], panel: readonly string[], gutter: number): readonly string[] {
    const height = Math.max(rows.length, panel.length);
    return Array.from({ length: height }, (_unused, index) => {
        const row = rows[index] ?? "";
        const note = panel[index];
        if (note === undefined) return row;
        // Every interior line of the panel opens and closes on a border glyph by construction, so
        // colouring those two positions colours the frame without touching the text between them.
        const painted =
            index === 0
                ? styleText(["cyan", "bold"], note)
                : index === panel.length - 1
                  ? styleText("cyan", note)
                  : `${styleText("cyan", S_BAR)}${note.slice(1, -1)}${styleText("cyan", S_BAR)}`;
        return `${row}${" ".repeat(Math.max(PICKER_PANEL_GAP, gutter - stripVTControlCharacters(row).length))}${painted}`;
    });
}

/**
 * The selection surface: clack's grouped multiselect, constructed directly rather than through
 * `groupMultiselect`, which builds the prompt, hands it a render closure, and returns `.prompt()` —
 * leaving no instance to bind keys to. `updateSettings({aliases})` is no substitute: it remaps keys
 * onto the existing action set and cannot introduce a new one.
 *
 * Only the composition is local. The glyphs, the sliding window, the wrapping, and the state symbol
 * all remain clack's, so the picker keeps looking like every other prompt in the wizard.
 */
async function pickDatasets(model: ReferencePickerModel, panel: readonly string[] | undefined): Promise<readonly string[] | undefined> {
    // Reserved so `limitOptions` wraps rows before the note rather than under it, and so every row can
    // be padded to the same column — a panel whose left edge moves with the longest visible row would
    // shift on every keystroke that changes the window.
    const reserved = panel === undefined ? PICKER_RAIL_COLUMNS : PICKER_RAIL_COLUMNS + PICKER_PANEL_GAP + PICKER_PANEL_WIDTH + 2;
    const gutter = getColumns(process.stdout) - PICKER_PANEL_WIDTH - 2 - PICKER_RAIL_COLUMNS;
    const prompt = new GroupMultiSelectPrompt<ReferencePickerEntry>({
        // Copied into mutable arrays: clack's option type is not readonly, and the model is immutable
        // data precisely so it can be asserted on without a terminal.
        options: Object.fromEntries(Object.entries(model.groups).map(([group, entries]) => [group, [...entries]])),
        // Deliberately empty. The bulk keys make any starting point one keystroke away, and an
        // untouched prompt plus Enter should install nothing rather than gigabytes.
        initialValues: [],
        required: false,
        selectableGroups: true,
        render() {
            const heading = `${symbol(this.state)}  ${PICKER_MESSAGE}\n`;
            const selected = this.value ?? [];
            if (this.state === "submit" || this.state === "cancel") {
                // A count, not the labels clack would list: the offered set reaches into the dozens,
                // and the confirmation that follows states the file count this resolves to anyway.
                const chosen = this.options.filter((option) => option.group !== true && selected.includes(option.value)).length;
                const summary =
                    this.state === "cancel" ? "cancelled" : chosen === 0 ? "nothing selected" : `${chosen} dataset${chosen === 1 ? "" : "s"} selected`;
                return `${heading}${styleText("gray", S_BAR)}  ${styleText("dim", summary)}`;
            }
            const rail = styleText("cyan", S_BAR);
            const rows = limitOptions({
                options: this.options,
                cursor: this.cursor,
                columnPadding: reserved,
                // The heading is one row and the legend two.
                rowPadding: 3,
                style: (option, active): string => {
                    const isGroup = option.group === true;
                    const ticked = isGroup ? this.isGroupSelected(String(option.value)) : selected.includes(option.value);
                    const box = ticked
                        ? styleText("green", S_CHECKBOX_SELECTED)
                        : active
                          ? styleText("cyan", S_CHECKBOX_ACTIVE)
                          : styleText("dim", S_CHECKBOX_INACTIVE);
                    // Leaves hang off a rail their last member closes, which is how clack draws a
                    // group: the next entry being a header (or nothing) marks the end of this one.
                    const next = this.options[this.options.indexOf(option) + 1];
                    const stem = isGroup ? "" : styleText("dim", `${next === undefined || next.group === true ? S_BAR_END : S_BAR} `);
                    const text = `${option.label}${option.hint === undefined ? "" : ` (${option.hint})`}`;
                    return `${stem}${box} ${active ? text : styleText("dim", text)}`;
                },
            })
                // Split back into physical lines: `limitOptions` returns one entry per option, and a
                // row too long for the window carries its own newlines, so entries are not lines and
                // anything painted beside them has to be aligned against what the terminal will show.
                .join("\n")
                .split("\n");
            const body = (panel === undefined ? rows : beside(rows, panel, gutter)).map((line) => `${rail}  ${line}`).join("\n");
            return `${heading}${body}\n${rail}  ${styleText("dim", model.footer)}\n${styleText("cyan", S_BAR_END)}\n`;
        },
    });

    prompt.on("key", (char) => {
        const selection = referencePickerBulkSelection(char, model);
        // No repaint here: `Prompt.onKeypress` emits `key` and then renders unconditionally, so the
        // frame drawn for this very keystroke already reflects the new value.
        if (selection !== undefined) prompt.value = [...selection];
    });

    const selected = await prompt.prompt();
    return isCancel(selected) ? undefined : selected;
}

/**
 * Frame the choice, then take it. `withheld` is what the caller kept out of `catalog` — already
 * installed and intact — and exists so the listing's omissions are stated rather than inferred.
 *
 * `undefined` means cancelled, and stays distinct from an empty selection.
 */
async function chooseIds(catalog: ReferenceDataCatalog, withheld: readonly ReferenceDatasetEntry[]): Promise<readonly string[] | undefined> {
    const disclosure = referenceSelectionDisclosure(withheld);
    if (catalog.datasets.length === 0) {
        // Nothing left to offer. Say why: an empty offer with no explanation is the state that sent
        // someone looking for an option that had quietly resolved to nothing.
        if (disclosure.length > 0) log.info(disclosure.join("\n"));
        return [];
    }
    // Decided once, here, rather than independently by the printer and the renderer — two width
    // checks a resize could disagree about would print the note twice or not at all.
    const floats = referenceNoteFloats(getColumns(process.stdout));
    const preamble = floats ? disclosure : [...disclosure, ON_DEMAND_REFERENCE_NOTE];
    if (preamble.length > 0) log.info(preamble.join("\n"));
    return pickDatasets(referencePickerModel(catalog, withheld), floats ? onDemandReferencePanel(PICKER_PANEL_WIDTH) : undefined);
}

/**
 * Trailing window the transfer rate is measured over. Long enough that one slow chunk does not read
 * as a stall, short enough that the number describes the connection now rather than its whole history.
 */
export const PROGRESS_RATE_WINDOW_MS = 3_000;
/** Minimum span the window must cover before a rate is stated at all — below it the number is noise. */
const PROGRESS_RATE_MIN_SPAN_MS = 1_000;
/** Floor between redraws, so a fast connection spends its time transferring rather than repainting. */
const PROGRESS_REFRESH_MS = 100;

/** What the readout knows at one moment; every sink renders from this and formats nothing itself. */
export type ReferenceProgressSnapshot = {
    /** Canonical readout — `12/38 files · 1.4 GB · 8.2 MB/s`, rate segment absent until measurable. */
    readonly line: string;
    /** Artifacts finished, never greater than `total`. */
    readonly completed: number;
    /** Artifacts the plan plans to fetch. */
    readonly total: number;
    /** Artifact in flight or just finished; absent before the first one opens. */
    readonly path?: string;
};

/**
 * Where a readout is painted. Two realizations exist — an animated clack bar and plain lines — and
 * tests supply a third that records snapshots, which is what keeps the formatting assertions honest
 * without a terminal.
 */
export type ReferenceProgressSink = {
    /** Opened once, before any artifact starts. */
    readonly start: (snapshot: ReferenceProgressSnapshot) => void;
    /** The byte/rate tail moved; no artifact finished. */
    readonly refresh: (snapshot: ReferenceProgressSnapshot) => void;
    /** An artifact finished. */
    readonly advance: (snapshot: ReferenceProgressSnapshot) => void;
    /** Closed once; `failure` carries the message when the transfer ended badly. */
    readonly finish: (snapshot: ReferenceProgressSnapshot, failure?: string) => void;
};

/** The animated readout: one clack progress bar over the whole plan. */
function clackProgressSink(total: number): ReferenceProgressSink {
    const bar = progress({ style: "block", max: total });
    let painted = 0;
    return {
        start: (snapshot) => bar.start(snapshot.line),
        refresh: (snapshot) => bar.message(snapshot.line),
        advance: (snapshot) => {
            // Advance by the delta against what the bar has already been told, so a clamped count
            // (a transfer that outran its estimate) refreshes the text without pushing the bar past
            // its own max.
            const step = snapshot.completed - painted;
            painted = snapshot.completed;
            if (step > 0) bar.advance(step, snapshot.line);
            else bar.message(snapshot.line);
        },
        finish: (snapshot, failure) => {
            if (failure === undefined) bar.stop(`Downloaded ${snapshot.line}`);
            else bar.error(`Download failed at ${snapshot.line}`);
        },
    };
}

/**
 * The captured-log readout: one line per completed artifact. Byte deltas paint nothing — a line per
 * chunk would bury the surrounding output in a log nobody can read. Exported because the terminal
 * check that selects it cannot be reached from a test process, and an untested log format is one
 * that silently grows escape codes.
 */
export function plainProgressSink(): ReferenceProgressSink {
    return {
        start: (snapshot) => console.log(`Downloading ${snapshot.total} reference file${snapshot.total === 1 ? "" : "s"}…`),
        refresh: () => undefined,
        advance: (snapshot) => console.log(`  ${snapshot.line}${snapshot.path === undefined ? "" : ` — ${snapshot.path}`}`),
        finish: (snapshot, failure) => console.log(failure === undefined ? `Downloaded ${snapshot.line}` : `Download failed at ${snapshot.line}`),
    };
}

/** A live readout over one transfer plan. */
export type ReferenceDownloadProgressReporter = {
    /** Feed one installer event. */
    readonly report: (event: ReferenceDownloadProgress) => void;
    /** Close the readout; always call it, on both the success and failure paths. */
    readonly finish: (failure?: string) => void;
};

/**
 * Build the combined readout for a plan of `totalArtifacts` files, or `undefined` when there is
 * nothing to draw. Returning `undefined` for an empty plan is the point: an all-intact selection
 * legitimately fetches zero files, and a bar whose denominator is zero has nothing to say — the
 * caller's existing summary already reports that outcome.
 *
 * Pass `sink` to render somewhere other than this process's terminal (tests do); by default the
 * animated bar is used only on a real interactive terminal, and captured output gets plain lines.
 */
export function createReferenceDownloadProgress(totalArtifacts: number, sink?: ReferenceProgressSink): ReferenceDownloadProgressReporter | undefined {
    if (!Number.isFinite(totalArtifacts) || totalArtifacts <= 0) return undefined;
    const total = Math.floor(totalArtifacts);
    const painter = sink ?? (isTTY(process.stdout) && !isCI() ? clackProgressSink(total) : plainProgressSink());

    let completed = 0;
    let bytes = 0;
    let path: string | undefined;
    let lastRefreshAt = 0;
    // Per-artifact progress for everything currently open, kept apart from the plan totals: the
    // active set is the only place a declared size can honestly be spent, since the plan's remaining
    // files have not been requested yet. Keyed by dataset and path because several transfer at once.
    const inFlight = new Map<string, { bytes: number; readonly declared?: number }>();
    const artifactKey = (datasetId: string, artifactPath: string): string => `${datasetId}/${artifactPath}`;
    // Cumulative-byte samples inside the window. Sampling is throttled with the redraw, so this holds
    // tens of entries rather than one per chunk.
    const samples: { at: number; bytes: number }[] = [];

    function rateBytesPerSecond(now: number): number | undefined {
        const first = samples[0];
        const last = samples[samples.length - 1];
        if (first === undefined || last === undefined) return undefined;
        // A stalled transfer emits nothing, so the newest sample simply ages. Reading its age against
        // `now` — rather than against the last sample — is what makes the rate decay to nothing
        // instead of freezing at whatever the connection was doing before it stopped.
        if (now - last.at > PROGRESS_RATE_WINDOW_MS) return undefined;
        const span = last.at - first.at;
        // Both guards matter: a window that has not filled yet would state a rate off one burst, and
        // a zero span would divide by zero. Either way the honest readout is no rate at all.
        if (span < PROGRESS_RATE_MIN_SPAN_MS) return undefined;
        const moved = last.bytes - first.bytes;
        return moved > 0 ? (moved / span) * 1000 : undefined;
    }

    /**
     * The active set: how many artifacts are open, and — only when every one of them declared a size
     * — the bytes received against the bytes declared across exactly those artifacts. Partial
     * knowledge yields the count alone rather than a denominator covering some of the set, which
     * would read as a total while describing a subset. Labelled "in flight" so it can never be
     * mistaken for the plan, whose byte total remains unknowable.
     */
    function renderInFlight(): string {
        if (inFlight.size === 0) return "";
        const active = [...inFlight.values()];
        const label = ` · ${active.length} in flight`;
        if (!active.every((artifact) => artifact.declared !== undefined)) return label;
        const received = active.reduce((total, artifact) => total + artifact.bytes, 0);
        // `?? 0` is unreachable — the `every` above proves each `declared` is present — and is used
        // in place of a non-null assertion so the arithmetic carries no escape hatch.
        const declared = active.reduce((total, artifact) => total + (artifact.declared ?? 0), 0);
        return `${label} ${received.formatBytes()}/${declared.formatBytes()}`;
    }

    function snapshot(now: number = Date.now()): ReferenceProgressSnapshot {
        const rate = rateBytesPerSecond(now);
        const line = `${completed}/${total} files · ${bytes.formatBytes()}${rate === undefined ? "" : ` · ${rate.formatBytes()}/s`}${renderInFlight()}`;
        return { line, completed, total, ...(path === undefined ? {} : { path }) };
    }

    painter.start(snapshot());
    // Nothing else repaints a stalled transfer: byte events are the only other trigger, and a stall
    // is precisely their absence. Unref'd so a hung download never holds the process open on its own.
    const heartbeat = setInterval(() => painter.refresh(snapshot()), PROGRESS_RATE_WINDOW_MS);
    heartbeat.unref();

    return {
        report: (event) => {
            const now = Date.now();
            switch (event.type) {
                case "artifact_started":
                    path = event.path;
                    inFlight.set(artifactKey(event.datasetId, event.path), {
                        bytes: 0,
                        ...(event.declaredBytes === undefined ? {} : { declared: event.declaredBytes }),
                    });
                    painter.refresh(snapshot(now));
                    return;
                case "artifact_bytes": {
                    bytes += event.bytes;
                    // Attributed to its own artifact, never to "the current one": with several
                    // transfers open, the most recently started is not the one these bytes came from.
                    const artifact = inFlight.get(artifactKey(event.datasetId, event.path));
                    if (artifact !== undefined) artifact.bytes += event.bytes;
                    if (now - lastRefreshAt < PROGRESS_REFRESH_MS) return;
                    lastRefreshAt = now;
                    samples.push({ at: now, bytes });
                    while (samples.length > 1 && now - (samples[0]?.at ?? now) > PROGRESS_RATE_WINDOW_MS) samples.shift();
                    painter.refresh(snapshot(now));
                    return;
                }
                case "artifact_completed":
                    path = event.path;
                    // Leaves the active set the moment it lands: a declared size describes the
                    // artifact that declared it, and what is still open is what the readout is about.
                    inFlight.delete(artifactKey(event.datasetId, event.path));
                    // Clamped, not incremented blindly: the estimate and the installer each decide
                    // "already intact" by digest at different moments, so a dataset damaged in between
                    // adds fetches the plan never predicted. The final summary stays authoritative.
                    completed = Math.min(completed + 1, total);
                    painter.advance(snapshot(now));
                    return;
                default: {
                    const unreachable: never = event;
                    throw new Error(`unhandled reference progress event: ${JSON.stringify(unreachable)}`);
                }
            }
        },
        finish: (failure) => {
            clearInterval(heartbeat);
            // Nothing is in flight once the plan is over — including on the failure path, where
            // whatever was open was abandoned rather than completed. The closing line reports totals.
            inFlight.clear();
            painter.finish(snapshot(), failure);
        },
    };
}

/** Headless, reusable download operation after selection and consent policy are resolved. */
export async function downloadReferences(
    options: ReferenceDownloadOptions,
): Promise<Result<ReferenceInstallOutcome | DeclinedReferenceDownload, ReferenceProvisionError>> {
    const catalog = options.source?.catalog ?? REFERENCE_DATA_CATALOG;
    const interactive = options.interactive ?? process.stdin.isTTY;
    const install = { force: options.force ?? false };
    let ids = options.ids;
    if (ids.length === 0) {
        if (!interactive) {
            // Not `unknown_dataset`: nothing was requested, so there is no unknown id to name. That
            // variant carries the id that missed, and an empty string there is a lie a caller could
            // pattern-match on.
            return err({
                type: "download_failed",
                message: `No reference ids supplied. Pass catalog ids explicitly on a non-interactive terminal. Available ids: ${catalog.datasets
                    .map((dataset) => dataset.id)
                    .join(", ")}`,
            });
        }
        // Offer what is not already there, so the picker never advertises work the estimate will
        // net back out. A forced run is the exception: it genuinely re-fetches an intact install, and
        // withholding those would leave `--force` with no ids unable to reach the dataset it exists
        // to repair.
        let offered = catalog;
        let withheld: readonly ReferenceDatasetEntry[] = [];
        if (!install.force) {
            const inspection = await inspectReferenceStore(env.refsDir, options.source?.catalog);
            if (inspection.isErr()) return err(inspection.error);
            offered = offeredReferenceCatalog(catalog, inspection.value);
            withheld = inspection.value.datasets.filter((item) => item.state === "installed").map((item) => item.dataset);
        }
        let chosen: readonly string[] | undefined;
        try {
            chosen = await chooseIds(offered, withheld);
        } catch (cause) {
            return err({ type: "download_failed", message: "Reference selection prompt failed.", cause });
        }
        if (chosen === undefined || chosen.length === 0) return ok({ installed: [], declined: true });
        ids = chosen;
    }

    const estimate = await referenceDownloadEstimate(ids, env.refsDir, options.source ?? undefined, install);
    if (estimate.isErr()) return err(estimate.error);
    const size = renderEstimate(estimate.value);
    console.log(`Reference download plan: ${size} to fetch from the upstream publishers.`);
    if (!options.yes) {
        if (!interactive) {
            return err({
                type: "download_failed",
                message: `Downloading ${size} requires explicit consent; re-run with --yes.`,
            });
        }
        let confirmed: boolean;
        try {
            confirmed = await (options.confirmDownload ?? confirm)(`Download ${size} of reference data into ${env.refsDir}?`);
        } catch (cause) {
            return err({ type: "download_failed", message: "Reference download confirmation failed.", cause });
        }
        if (!confirmed) {
            return ok({ installed: [], declined: true });
        }
    }
    // Built only after consent, so nothing is drawn for a transfer the user has not agreed to, and
    // absent entirely when the plan fetches nothing.
    const readout = createReferenceDownloadProgress(estimate.value.artifactsToFetch);
    let installed: Result<ReferenceInstallOutcome, ReferenceProvisionError> | undefined;
    try {
        installed = await installReferenceDatasets(
            ids,
            {
                root: env.refsDir,
                ...(options.source === undefined ? {} : { source: options.source }),
                ...(readout === undefined ? {} : { onProgress: readout.report }),
            },
            install,
        );
        return installed;
    } finally {
        // A live readout owns a repaint timer and holds the terminal in the bar's render state, so it
        // has to be closed on every exit — including one the installer's own `Result` channel cannot
        // describe, such as a caller-supplied catalog seam that throws. `installed` is undefined only
        // on that path, which is exactly the case the failure wording is for.
        readout?.finish(installed === undefined ? "the transfer ended unexpectedly" : installed.isErr() ? installed.error.message : undefined);
    }
}

/** `inflexa refs path` — print the public path without creating it. */
export function runRefsPath(): void {
    console.log(env.refsDir);
}

/**
 * `inflexa refs list` — render canonical options and recoverable local state. Pass `urls` to also
 * print the exact upstream download URL of every artifact, so the source is inspectable before consent.
 * Pass `json` for the machine-readable document instead of prose; `urls` has no effect on it (artifact
 * URLs are always in the JSON). `source` is a catalog seam for offline tests, mirroring the download path.
 */
export async function runRefsList(options: { readonly urls?: boolean; readonly json?: boolean; readonly source?: ReferenceCatalogSource } = {}): Promise<void> {
    const result = await inspectReferenceStore(env.refsDir, options.source?.catalog);
    if (options.json) {
        // Stdout purity: exactly one document on success (console.log supplies the trailing newline),
        // nothing on failure — the same prose the human mode prints goes to stderr with a non-zero exit.
        result.match(
            (inspection) => console.log(JSON.stringify(buildReferenceListDocument(inspection, env.refsDir), null, 2)),
            (error) => {
                console.error(`Reference-data inspection failed: ${renderError(error)}`);
                process.exitCode = 1;
            },
        );
        return;
    }
    result.match(
        (inspection) => {
            if (inspection.datasets.length === 0) console.log("No catalog reference datasets are published by this harness version yet.");
            // Datasets arrive in catalog order, which clusters by group, so a header printed on each
            // group change renders the listing as labelled categories instead of one flat wall.
            let lastGroup: string | undefined;
            for (const item of inspection.datasets) {
                const dataset = item.dataset;
                if (dataset.recommendation.group !== lastGroup) {
                    lastGroup = dataset.recommendation.group;
                    console.log(`\n== ${lastGroup} ==`);
                }
                console.log(`\n${dataset.id}  ${dataset.version}  ${item.state}${dataset.recommendation.recommended ? "" : "  (optional)"}`);
                console.log(`  ${dataset.title} — ${dataset.description}`);
                console.log(`  Size: ${formatDatasetSize(dataset)}`);
                console.log(`  Source: ${dataset.sourceUrl}`);
                console.log(`  License: ${dataset.license.identifier}${dataset.license.url ? ` — ${dataset.license.url}` : ""}`);
                if (options.urls) for (const artifact of dataset.artifacts) console.log(`  URL: ${artifact.url}`);
            }
            if (inspection.userContent.length > 0) {
                console.log(`\nUser/unmanaged top-level content: ${inspection.userContent.join(", ")} (left untouched)`);
            }
            console.log(
                "\nEvery dataset is fetched straight over HTTPS from the third party that publishes it; nothing is mirrored, re-hosted, or checksum-pinned here.",
            );
            console.log("Integrity is trust-on-first-use: `inflexa refs verify` checks each installed file against the copy you downloaded.");
            if (!options.urls) console.log("Re-run with `--urls` to print the exact upstream URL of every file.");
            console.log(`Add arbitrary references under ${env.refsDir}/user; sandboxes discover them dynamically.`);
            console.log("Missing a reusable option? Open a PR adding its upstream URL, provenance, and licensing to the harness reference-data catalog.");
        },
        (error) => {
            console.error(`Reference-data inspection failed: ${renderError(error)}`);
            process.exitCode = 1;
        },
    );
}

/** `inflexa refs download` command action. */
export async function runRefsDownload(ids: readonly string[], options: { readonly yes?: boolean; readonly force?: boolean }): Promise<void> {
    const result = await downloadReferences({ ids, yes: options.yes, force: options.force });
    result.match(
        (outcome) => {
            if ("declined" in outcome) console.log("Cancelled — no reference data activated.");
            else if (outcome.installed.length === 0) console.log("No reference datasets selected.");
            else
                for (const installed of outcome.installed)
                    console.log(
                        installed.bytesDownloaded === 0
                            ? `Already installed and intact: ${installed.id}@${installed.version} (nothing downloaded).`
                            : `Installed ${installed.id}@${installed.version} (${installed.bytesDownloaded.formatBytes()} downloaded).`,
                    );
        },
        (error) => {
            console.error(`Reference-data download failed: ${renderError(error)}`);
            process.exitCode = 1;
        },
    );
}

/**
 * `inflexa refs verify` command action. Pass `json` for the machine-readable document instead of prose.
 * `source` is a catalog/plan seam for offline tests that must reach both the no-ids selection inspection
 * and the verification itself, mirroring the download path.
 */
export async function runRefsVerify(
    ids: readonly string[],
    options: { readonly json?: boolean; readonly source?: ReferenceCatalogSource } = {},
): Promise<void> {
    let selected = ids;
    if (selected.length === 0) {
        const inspection = await inspectReferenceStore(env.refsDir, options.source?.catalog);
        if (inspection.isErr()) {
            console.error(`Reference-data verification failed: ${renderError(inspection.error)}`);
            process.exitCode = 1;
            return;
        }
        selected = inspection.value.datasets.filter((item) => item.receipt !== undefined || item.state === "invalid_receipt").map((item) => item.dataset.id);
    }
    const result = await verifyReferenceDatasets(env.refsDir, selected, options.source);
    if (options.json) {
        // The document already carries the damaged states, so a non-zero exit is enough to flag damage —
        // the human mode's "Re-download to repair" hint is suppressed to keep stderr for genuine failures.
        result.match(
            (verified) => {
                console.log(JSON.stringify(buildReferenceVerifyDocument(verified), null, 2));
                if (verified.some((dataset) => dataset.state !== "valid")) process.exitCode = 1;
            },
            (error) => {
                console.error(`Reference-data verification failed: ${renderError(error)}`);
                process.exitCode = 1;
            },
        );
        return;
    }
    result.match(
        (verified) => {
            if (verified.length === 0) console.log("No installed catalog reference datasets to verify.");
            for (const dataset of verified) {
                console.log(`${dataset.datasetId}${dataset.version ? `@${dataset.version}` : ""}: ${dataset.state}`);
                for (const file of dataset.files) {
                    console.log(`  ${file.state.padEnd(8)} ${file.path}  (vs the checksum recorded at install)`);
                }
            }
            const damaged = verified.filter((dataset) => dataset.state !== "valid");
            if (damaged.length > 0) {
                console.error(`\nRe-download to repair: inflexa refs download ${damaged.map((dataset) => dataset.datasetId).join(" ")} --force --yes`);
                process.exitCode = 1;
            }
        },
        (error) => {
            console.error(`Reference-data verification failed: ${renderError(error)}`);
            process.exitCode = 1;
        },
    );
}

/**
 * The datasets setup actually offers: everything the catalog names except what is already installed
 * and intact. Every preset resolves against this, not the raw catalog — which is what keeps
 * "Everything" from meaning "re-fetch what you already have" and keeps an intact store out of the
 * counts shown on the prompt.
 */
export function offeredReferenceCatalog(catalog: ReferenceDataCatalog, inspection: ReferenceStoreInspection): ReferenceDataCatalog {
    const offered = new Set(inspection.datasets.filter((item) => item.state !== "installed").map((item) => item.dataset.id));
    return { ...catalog, datasets: catalog.datasets.filter((dataset) => offered.has(dataset.id)) };
}

/** Deliberate reference-store setup reused by the main setup wizard. */
export async function runReferenceSetup(options: ReferenceSetupOptions): Promise<Result<void, ReferenceProvisionError>> {
    const created = await ensureReferenceStore(env.refsDir);
    if (created.isErr()) return err(created.error);
    if (options.ids !== undefined) {
        if (options.ids.length === 0) return ok(undefined);
        if (!options.interactive && !options.yes) {
            log.info(`Reference selection was not downloaded without explicit consent.\n  Re-run setup with --refs ${options.ids.join(",")} --yes.`);
            return ok(undefined);
        }
        const downloaded = await downloadReferences({
            ids: options.ids,
            yes: options.yes,
            interactive: options.interactive,
            ...(options.source === undefined ? {} : { source: options.source }),
        });
        return downloaded.map(() => undefined);
    }
    const activeCatalog = options.source?.catalog ?? REFERENCE_DATA_CATALOG;
    const inspection = await inspectReferenceStore(env.refsDir, options.source?.catalog);
    if (inspection.isErr()) return err(inspection.error);
    const offered = inspection.value.datasets.filter((item) => item.state !== "installed");
    if (offered.length === 0) {
        log.info("Reference store ready; no missing catalog datasets to offer.");
        return ok(undefined);
    }
    // `--refs` omitted on a headless terminal used to install nothing, so an unattended setup left the
    // enrichment/network/single-cell skills with no data to stand on. Default to the catalog's
    // recommended set instead — the only signal for what a working install looks like — while still
    // gating the transfer on the same explicit `--yes` consent every other download path requires.
    if (!options.interactive) {
        const recommendedOffered = offered.filter((item) => item.dataset.recommendation.recommended).map((item) => item.dataset.id);
        if (recommendedOffered.length === 0) {
            log.info(`Reference store: ${env.refsDir}\n  Install catalog data later with \`inflexa refs download <id...> --yes\`.`);
            return ok(undefined);
        }
        if (!options.yes) {
            log.info(
                `Reference store: ${env.refsDir}\n  ${recommendedOffered.length} recommended dataset(s) are the default install but need explicit consent.\n  Re-run setup with --yes, or \`inflexa refs download ${recommendedOffered.join(" ")} --yes\`.`,
            );
            return ok(undefined);
        }
        const downloaded = await downloadReferences({
            ids: recommendedOffered,
            yes: true,
            interactive: false,
            ...(options.source === undefined ? {} : { source: options.source }),
        });
        return downloaded.map(() => undefined);
    }
    let chosen: readonly string[] | undefined;
    try {
        chosen = await chooseIds(
            offeredReferenceCatalog(activeCatalog, inspection.value),
            inspection.value.datasets.filter((item) => item.state === "installed").map((item) => item.dataset),
        );
    } catch (cause) {
        return err({ type: "download_failed", message: "Reference selection prompt failed.", cause });
    }
    if (chosen === undefined || chosen.length === 0) return ok(undefined);
    const downloaded = await downloadReferences({
        ids: chosen,
        yes: options.yes,
        interactive: true,
        ...(options.source === undefined ? {} : { source: options.source }),
    });
    return downloaded.map(() => undefined);
}
