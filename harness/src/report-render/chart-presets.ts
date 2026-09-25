/**
 * The constants, the classification, and the volcano expansion that the dense figure modules read.
 *
 * Each default of a figure is a declared constant of this module, and a declared threshold pair replaces
 * one. A guide line carries such a value, and a guide is never a plotted value.
 *
 * A figure can carry a classification. The classification reads the plotted pair of one row against the
 * same values that the guides carry, thus the color split lands on the drawn lines. It reads one row at a
 * time, and it computes no aggregate. The page builds the series of a dense figure from the rule of the
 * classification, thus the rule is plain data.
 *
 * The volcano declares its own transform on the p channel. Thus it reads the column of that channel and it
 * drops an authored transform there, and no value takes the transform two times.
 */

import {
    channelColumn,
    channelTransform,
    type ChartChannel,
    type ChartComposition,
    type ChartEncoding,
    type ChartThresholds,
} from "../contracts/report-blocks.js";
import { formatTableCell, typographicExponent } from "./number-format.js";

/** The default p-value threshold of a volcano. The guide line sits at the transformed value of it. */
export const VOLCANO_P_THRESHOLD = 0.05;

/** The default effect threshold of a volcano. One guide line sits at each side of zero. */
export const VOLCANO_EFFECT_THRESHOLD = 1;

/** The genome-wide significance threshold of a Manhattan plot. */
export const MANHATTAN_P_THRESHOLD = 5e-8;

/** The baseline of an MA plot. A point above it rose, and a point below it fell. */
export const MA_BASELINE = 0;

/**
 * The x title of a volcano. The two effect guides sit at `±1`, which is a log2 claim, thus the preset states
 * the same quantity in words.
 */
const LOG2_EFFECT_TITLE = "log2 fold change";

/** The y title of a preset that transforms its p column. The minus sign is the character, not a hyphen. */
const NEG_LOG10_P_TITLE = "−log10(p)";

/** The semantic axis titles of one preset. A preset whose axis carries no fixed quantity states none. */
export interface PresetAxisTitles {
    readonly x?: string;
    readonly y?: string;
}

/** One category of a preset classification: the name that a legend reads, and whether it states no finding. */
export interface PresetCategory {
    readonly name: string;
    readonly muted: boolean;
}

/**
 * The classification rule as plain data: the kind of the split, and the two cuts that it reads.
 *
 * `categoryOf` is a function, thus it reaches no page. A chart that reads the shared payload builds its
 * series in the browser, and this shape is what such a build takes. The two forms answer alike, and the
 * shared test vector holds them together.
 *
 * The volcano rule reads the plotted pair. `cut` sits on the plotted y value, which is the transformed
 * p-value, and `effect` sits on the plotted x value. It gives the place of the category in `categories`: 0
 * for the down side, 1 for the up side, and 2 for the null category.
 *
 * The MA rule reads a third column, the p-value `column`, against `cut` on its untransformed scale. It gives
 * 0 for a row under the cut and 1 for every other row, a row with no p included. The x axis of an MA is
 * logarithmic, thus a row whose x is not positive belongs to no category.
 */
export type PresetRule =
    { readonly kind: "volcano"; readonly cut: number; readonly effect: number } | { readonly kind: "ma"; readonly column: string; readonly cut: number };

/**
 * The per-row classification of one preset.
 *
 * `categoryOf` reads the plotted pair of one row, and the row index where the rule reads a third column of
 * that row. Thus it computes no aggregate, and it compares each point against the same numbers that the
 * guide lines carry. The color split then lands on the drawn lines. A row that gives no pair belongs to no
 * category, and its point drops.
 */
export interface PresetClassification {
    readonly categories: readonly PresetCategory[];
    readonly categoryOf: (x: number | null, y: number | null, index: number) => string | undefined;
    readonly rule: PresetRule;
}

/** The expansion of the volcano: the composition of its points and its guides, and its classification. */
export interface PresetExpansion {
    readonly composition: ChartComposition;
    readonly classification: PresetClassification;
}

/**
 * The three category names of a volcano.
 *
 * The two signal names state the side of the effect axis. The null name reads as the standard legend of a
 * volcano, and the muted rule of the renderer reads the same text.
 */
const VOLCANO_DOWN = "Down";
const VOLCANO_UP = "Up";
const VOLCANO_NULL = "Not significant";

/**
 * The composition of a volcano: the effect on x, the transformed p-value on y, three guide lines, and the
 * three-way classification.
 *
 * `x` and `y` are the two channels that the volcano demands, and the caller refuses an absent one. `encoding`
 * supplies the optional `label` channel. `thresholds` carries the pair that the author declared, and an absent
 * pair gives the two constants of this module.
 *
 * The two effect guides sit at each side of zero, and the p guide sits at the transformed significance. The
 * expression of the guide is the expression of the `neg_log10` transform, thus the guide and the points
 * share one scale. The classification reads the same two numbers, thus the color split lands on the lines.
 * The label of the p guide prints the cut as a p-value column prints it, with the power of ten of a figure.
 */
export function expandVolcano(x: ChartChannel, y: ChartChannel, encoding: ChartEncoding, thresholds: ChartThresholds | undefined): PresetExpansion {
    const pColumn = channelColumn(y);
    const significance = thresholds?.significance ?? VOLCANO_P_THRESHOLD;
    const effect = thresholds?.effect ?? VOLCANO_EFFECT_THRESHOLD;
    return {
        composition: {
            series: [
                {
                    form: "scatter",
                    encoding: { x, y: { column: pColumn, transform: "neg_log10" }, ...optionalChannels(encoding) },
                },
            ],
            annotations: [
                {
                    kind: "reference-line",
                    axis: "y",
                    value: -Math.log10(significance),
                    label: `p ${typographicExponent(formatTableCell(significance, "scientific"))}`,
                },
                { kind: "reference-line", axis: "x", value: -effect },
                { kind: "reference-line", axis: "x", value: effect },
            ],
        },
        classification: volcanoClassification(significance, effect),
    };
}

/**
 * The three-way split of a volcano, one row at a time.
 *
 * The significance cut is the value of the y guide, thus the test compares the plotted y against the drawn
 * line. The effect cuts are the two x guides, and the test compares the plotted x against them. A point on
 * a guide takes the null category, thus a guide belongs to neither side of itself.
 *
 * The down category emits first. The palette of the theme opens with the down color and the up color of the
 * design tokens, thus each side takes its conventional color from the palette order alone.
 *
 * The rule states the same two cuts as plain data. A chart that ships no row builds its series in the
 * browser from the rule, thus the two splits read one pair of numbers.
 */
function volcanoClassification(significance: number, effect: number): PresetClassification {
    const cut = -Math.log10(significance);
    return {
        categories: [
            { name: VOLCANO_DOWN, muted: false },
            { name: VOLCANO_UP, muted: false },
            { name: VOLCANO_NULL, muted: true },
        ],
        rule: { kind: "volcano", cut, effect },
        categoryOf: (plottedX, plottedY) => {
            if (plottedX === null || plottedY === null) return undefined;
            if (plottedY <= cut) return VOLCANO_NULL;
            if (plottedX < -effect) return VOLCANO_DOWN;
            if (plottedX > effect) return VOLCANO_UP;
            return VOLCANO_NULL;
        },
    };
}

/**
 * The semantic axis titles of a volcano. It plots a log2 effect against the transformed p, thus it names them
 * in words.
 *
 * A channel that carries an authored transform plots a derived quantity, thus the semantic title would state
 * the wrong one. Such a channel takes no title, and the derived name of the renderer states the true quantity.
 * The y channel takes the transform of the volcano itself, thus its title is exact.
 *
 * The titles rank under a declared column label. Thus they ride beside the composition and never inside its
 * `axes` field, where an agent title sits and where they would outrank the label.
 */
export function volcanoAxisTitles(x: ChartChannel): PresetAxisTitles {
    return { ...(channelTransform(x) === undefined ? { x: LOG2_EFFECT_TITLE } : {}), y: NEG_LOG10_P_TITLE };
}

/** The two optional channels that the volcano carries through from the quick-path encoding. */
function optionalChannels(encoding: ChartEncoding): { group?: ChartChannel; label?: string } {
    return {
        ...(encoding.group !== undefined ? { group: encoding.group } : {}),
        ...(encoding.label !== undefined ? { label: encoding.label } : {}),
    };
}
