/**
 * The figure registry: one module for each chart type that draws the canonical figure of its field.
 *
 * A canonical figure often draws more than the series of one grid over one table: a table under the plot, a
 * text column beside it, stacked panels, a glyph in a cell, or a track from a second table. Thus a figure is a
 * module of its own, and `deriveRaw` in `chart.ts` asks this registry before every other path. A base type
 * with no module keeps its fixed rule. A preset with no module refuses, because no other path draws it.
 *
 * A module states the members of the block that it reads. The dispatch refuses each other member before the
 * module runs, thus a module never meets a channel that it would drop in silence.
 *
 * A module is a pure function of the block, the rows, and the context. It reads no clock, no random value, and
 * no locale, and its option holds no function, because the option rides to the page as inline JSON.
 */

import type { Result } from "neverthrow";

import type { ChartBlock, ChartComposition, ChartEncoding, ChartType } from "../../contracts/report-blocks.js";
import type { PresetAxisTitles, PresetClassification } from "../chart-presets.js";
import type { ChartRow, EchartOption } from "../chart.js";
import type { RenderProblem } from "../types.js";
import type { ColumnLabels, ColumnMeanings, FigureStatistic } from "./common.js";
import { GSEA_FIGURE } from "./gsea.js";
import { LOLLIPOP_FIGURE } from "./lollipop.js";
import { ONCOPRINT_FIGURE } from "./oncoprint.js";
import { FOREST_FIGURE } from "./forest.js";
import { KM_FIGURE } from "./km.js";
import { ROC_FIGURE } from "./roc.js";
import { MA_FIGURE } from "./ma.js";
import { MANHATTAN_FIGURE } from "./manhattan.js";
import { QQ_FIGURE } from "./qq.js";
import { VOLCANO_FIGURE } from "./volcano.js";
import { DOTPLOT_FIGURE } from "./dotplot.js";
import { EMBEDDING_FIGURE } from "./embedding.js";
import { HEATMAP_FIGURE } from "./heatmap.js";
import { PCA_FIGURE } from "./pca.js";

/**
 * The presets that exist as a figure module alone. No composition expands them, thus each one draws only
 * through its module.
 */
export const FIGURE_PRESET_TYPES = ["pca", "embedding", "dotplot", "forest", "roc", "qq", "gsea", "oncoprint", "lollipop"] as const;

/** One preset that exists as a figure module alone. */
export type FigurePresetType = (typeof FIGURE_PRESET_TYPES)[number];

/** True when the chart type exists as a figure module alone. */
export function isFigurePresetType(chartType: ChartType): chartType is FigurePresetType {
    return (FIGURE_PRESET_TYPES as readonly string[]).includes(chartType);
}

/**
 * The chart types that draw through a figure module alone: each figure preset, the heatmap, and the four
 * presets of the first grammar. No base rule draws the annotation strips of a heatmap, thus the heatmap keeps
 * no base rule beside its module. The volcano, the MA plot, the Manhattan plot, and the Kaplan-Meier curve
 * each draw elements that no composition holds, thus none of them keeps an expansion beside its module.
 */
export const MODULE_ONLY_TYPES = [...FIGURE_PRESET_TYPES, "heatmap", "volcano", "ma", "manhattan", "km"] as const;

/** One chart type that draws through a figure module alone. */
export type ModuleOnlyType = (typeof MODULE_ONLY_TYPES)[number];

/** True when the chart type draws through a figure module alone. */
export function isModuleOnlyType(chartType: ChartType): chartType is ModuleOnlyType {
    return (MODULE_ONLY_TYPES as readonly string[]).includes(chartType);
}

/**
 * One member of a chart block that a figure can read: a channel of the quick-path encoding, the statistics,
 * the track, or the focus.
 */
export type FigureMember = keyof ChartEncoding | "statistics" | "track" | "focus";

/**
 * The resolved track of a figure: the rows of the second table, its declared column order, and the columns
 * that the block names in it. The labels and the meanings are the declarations of the track binding.
 */
export interface FigureTrack {
    readonly rows: readonly ChartRow[];
    readonly columns?: readonly string[];
    readonly start: string;
    readonly end: string;
    readonly label: string;
    readonly length?: string;
    readonly labels: ColumnLabels;
    readonly meanings: ColumnMeanings;
}

/**
 * The parts of a preset that a figure hands to the composition machinery: the semantic axis titles, and the
 * per-row classification where the figure splits the rows itself. `colorOnTop` draws the points of a
 * continuous color in the ascending order of the color, inline and on the page, thus the high values draw on
 * top.
 *
 * `keepsRowsInline` keeps the rows of the composition inline whatever their size. A figure that rewrites the
 * items of the composition output states it, because the page builds each item from the cells and never
 * from the rewrite.
 */
export interface FigureComposeExtras {
    readonly preset?: PresetAxisTitles;
    readonly classification?: PresetClassification;
    readonly colorOnTop?: boolean;
    readonly keepsRowsInline?: boolean;
}

/**
 * What one figure reads beside its block and its rows.
 *
 * - `labels` and `meanings` are the declarations of the bound table, and `columns` is its declared column
 *   order.
 * - `statistics` holds each statistic of the block in block order, with its resolved value and its shown text.
 *   A block with no statistic gives an empty list.
 * - `track` is the resolved second table, where the block binds one.
 * - `textPx` is the text size of the page. The export scales each `graphic` text from it.
 * - `compose` derives one composition over the bound rows through the shared machinery of `chart.ts`. A dense
 *   figure builds its primary series here, thus the series reads the shared payload of its artifact past the
 *   inline bound. A figure can add series after the result, and each such series keeps its rows inline. A
 *   figure that puts a series before the result keeps the whole chart inline, because the page fills the
 *   leading series from the descriptors of the composition.
 */
export interface FigureContext {
    readonly blockId: string;
    readonly labels: ColumnLabels;
    readonly meanings: ColumnMeanings;
    readonly columns?: readonly string[];
    readonly statistics: readonly FigureStatistic[];
    readonly track?: FigureTrack;
    readonly textPx: number;
    readonly compose: (composition: ChartComposition, extras?: FigureComposeExtras) => Result<EchartOption, RenderProblem>;
}

/** The derivation of one figure: the raw option, before the layout discipline and the figure rules. */
export type FigureDerivation = (block: ChartBlock, rows: readonly ChartRow[], context: FigureContext) => Result<EchartOption, RenderProblem>;

/** One figure module: the members of the block that it reads, and its derivation. */
export interface FigureModule {
    readonly reads: ReadonlySet<FigureMember>;
    readonly derive: FigureDerivation;
}

/** The figure module of each chart type that has one. */
export type FigureRegistry = Readonly<Partial<Record<ChartType, FigureModule>>>;

/** The registered figure modules. A module joins by one entry here, keyed by its chart type. */
export const FIGURE_MODULES: FigureRegistry = {
    km: KM_FIGURE,
    forest: FOREST_FIGURE,
    roc: ROC_FIGURE,
    gsea: GSEA_FIGURE,
    oncoprint: ONCOPRINT_FIGURE,
    lollipop: LOLLIPOP_FIGURE,
    volcano: VOLCANO_FIGURE,
    ma: MA_FIGURE,
    manhattan: MANHATTAN_FIGURE,
    qq: QQ_FIGURE,
    pca: PCA_FIGURE,
    embedding: EMBEDDING_FIGURE,
    dotplot: DOTPLOT_FIGURE,
    heatmap: HEATMAP_FIGURE,
};

/**
 * The chart types that read each member that the canonical figures add. The refusal of such a member names
 * these types, and the teaching text of the member names the same ones.
 */
export const FIGURE_MEMBER_READERS: Readonly<
    Record<"shape" | "p" | "censor" | "risk" | "hit" | "metric" | "tracks" | "statistics" | "track", readonly ChartType[]>
> = {
    shape: ["pca", "scatter"],
    p: ["ma", "forest"],
    censor: ["km"],
    risk: ["km"],
    hit: ["gsea"],
    metric: ["gsea"],
    tracks: ["heatmap", "oncoprint"],
    statistics: ["km", "roc", "qq", "gsea"],
    track: ["lollipop"],
};
