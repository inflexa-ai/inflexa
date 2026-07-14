/**
 * ECharts layout normalization — the renderer-side invariant behind `show_user(kind: "echart")`.
 *
 * The layout discipline (no duplicate title, bottom legend, grid margins that fit the axis labels,
 * every category label shown, a downloadable chart) is applied HERE, deterministically, rather than
 * being a checklist the model must remember on every chart it composes. A rule a model must remember
 * is a rule it can forget.
 *
 * Two invariants govern every rule below:
 *
 * 1. **Defaults, not overrides.** Every property is filled in only when the author left it unset —
 *    an explicit, sensible authored `grid`/`legend`/`rotate`/filename is respected. The two forced
 *    fields are `title` (deleted: the `show_user` `title` param is the card heading, so an in-spec
 *    title is a genuine duplicate render) and `axisLabel.interval` (pinned to `0`: ECharts' default
 *    `"auto"` SILENTLY DROPS labels, which is the exact bug this rule exists to prevent).
 * 2. **Never turn a valid chart invalid.** Nothing here is derived from data that may be absent: a
 *    property is only injected where it is meaningful (a `grid` only for a cartesian chart), and an
 *    unknown category count yields the safe layout rather than a guessed one.
 *
 * Pure: the input spec is never mutated. Modified branches are copy-on-write; untouched branches are
 * shared by reference. `normalize(normalize(x))` deep-equals `normalize(x)`.
 */

/** Max length of a derived `saveAsImage` filename. */
const MAX_FILENAME_LEN = 64;

/** Fallback download filename when no heading is available to derive one from. */
const DEFAULT_FILENAME = "chart";

export interface NormalizeEchartSpecOptions {
    /**
     * The `show_user` `title` param — the card heading rendered above the chart canvas. Seeds the
     * `saveAsImage` download filename when the author supplied none.
     */
    title?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The axis entries of an `xAxis`/`yAxis` option, which ECharts accepts as one object or an array. */
function axisEntries(axis: unknown): Record<string, unknown>[] {
    if (Array.isArray(axis)) return axis.filter(isRecord);
    return isRecord(axis) ? [axis] : [];
}

/**
 * Kebab-case download filename: `"HMGCR — VST Expression"` → `"hmgcr-vst-expression"`.
 * Diacritics are folded, every other non-alphanumeric run collapses to a single dash.
 */
export function kebabFilename(source: string | undefined): string {
    const slug = (source ?? "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, MAX_FILENAME_LEN)
        .replace(/^-+|-+$/g, "");
    return slug.length > 0 ? slug : DEFAULT_FILENAME;
}

/** Declared series count. `0` = none declared, which is also "nothing a legend could label". */
function seriesCount(spec: Record<string, unknown>): number {
    const series = spec.series;
    if (Array.isArray(series)) return series.length;
    return isRecord(series) ? 1 : 0;
}

/** True when any series maps its categories to dataset COLUMNS rather than rows. */
function laysOutByRow(spec: Record<string, unknown>): boolean {
    const series = Array.isArray(spec.series) ? spec.series : [spec.series];
    return series.some((s) => isRecord(s) && s.seriesLayoutBy === "row");
}

/** Header rows to discount from a `dataset.source` array, per ECharts' `sourceHeader` rules. */
function headerRowCount(dataset: Record<string, unknown>, source: unknown[]): number {
    const declared = dataset.sourceHeader;
    if (declared === true) return 1;
    if (declared === false) return 0;
    if (typeof declared === "number" && Number.isFinite(declared)) {
        return Math.min(Math.max(Math.trunc(declared), 0), source.length);
    }
    // `"auto"` (the default): a leading row of all-strings in front of further rows is dimension names.
    const first = source[0];
    return source.length > 1 && Array.isArray(first) && first.length > 0 && first.every((cell) => typeof cell === "string") ? 1 : 0;
}

/**
 * Category count on the x axis, or `null` when the spec cannot tell us.
 *
 * `null` is the honest answer for a CSV-backed chart (`show_user`'s `dataPath`): the rows are loaded
 * by the host at render time and deliberately never pulled through the model's context window, so
 * they are NOT in the spec. Guessing a rotation for an axis of unknown length is worse than not
 * rotating — an unrotated axis is also exactly what the other `null` cases (a value axis: scatter,
 * time series) want. The count is used ONLY to pick a label rotation; it never touches the data, so
 * an off-by-one at a bucket boundary costs at most a rotation, never a rendering.
 */
export function categoryCount(spec: Record<string, unknown>): number | null {
    for (const axis of axisEntries(spec.xAxis)) {
        // An explicit category list is unambiguous — prefer it over any dataset inference.
        if (Array.isArray(axis.data)) return axis.data.length;
    }

    // An array of datasets, an object-of-columns `source`, or a row-major layout: do not guess.
    const dataset = spec.dataset;
    if (!isRecord(dataset) || laysOutByRow(spec)) return null;
    const source = dataset.source;
    if (!Array.isArray(source) || source.length === 0) return null;

    return Math.max(0, source.length - headerRowCount(dataset, source));
}

/** The label rotation for `count` categories, or `null` for "leave the labels horizontal". */
function rotationFor(count: number | null): number | null {
    if (count === null || count <= 10) return null;
    // >20 categories: ECharts' own escape hatch is a `dataZoom` slider, but that rewrites the chart's
    // interaction model and its vertical budget — a 90° turn is the mutation that cannot surprise.
    return count <= 20 ? 45 : 90;
}

/** True when the legend (authored or defaulted) sits below the chart and consumes bottom margin. */
function isBottomLegend(legend: unknown): boolean {
    const entries = Array.isArray(legend) ? legend.filter(isRecord) : isRecord(legend) ? [legend] : [];
    return entries.some((entry) => entry.show !== false && entry.bottom !== undefined);
}

/** True when a component option carries any explicit placement — adding another would fight it. */
function hasPlacement(option: Record<string, unknown>): boolean {
    return option.left !== undefined || option.right !== undefined || option.top !== undefined || option.bottom !== undefined;
}

/**
 * Apply the ECharts layout invariant to an author-composed spec.
 *
 * - `title` is deleted (always) — the `show_user` `title` param is the visible card heading, and
 *   `title.subtext` is the documented misuse for stats that belong in the tooltip.
 * - `legend` defaults to `{ bottom: 0 }` for a multi-series chart and `{ show: false }` for a
 *   single-series one (nothing to disambiguate); an authored legend is left alone.
 * - `grid` (cartesian charts only) gets `top` 8% — 12% when a `graphic` annotation shares the canvas
 *   — `bottom` 20% / 25% (rotated labels) / 30% (rotated labels above a bottom legend), `left` 10%,
 *   `right` 5%. Only unset keys are filled.
 * - `axisLabel.interval` is pinned to `0` on every axis; the x axis is rotated 45° (11–20 categories)
 *   or 90° (>20) unless the author chose a rotation.
 * - `toolbox.feature.saveAsImage` is injected with `type: "png"` and a kebab-case filename derived
 *   from the `show_user` title (falling back to the stripped in-spec title, then `"chart"`).
 */
export function normalizeEchartSpec(spec: Record<string, unknown>, opts: NormalizeEchartSpecOptions = {}): Record<string, unknown> {
    const { title: specTitle, ...out } = spec;

    // ── Legend ──────────────────────────────────────────────────────────
    const legendAuthored = out.legend !== undefined && out.legend !== null;
    if (!legendAuthored) {
        const count = seriesCount(out);
        if (count >= 2) out.legend = { bottom: 0 };
        // A single series has nothing to disambiguate: hide it explicitly rather than omit it, so a
        // themed legend component cannot reintroduce an orphan swatch. An undeclared series count
        // (0) gets no legend option at all — there is nothing to show or hide.
        else if (count === 1) out.legend = { show: false };
    }
    const bottomLegend = isBottomLegend(out.legend);

    // ── Axis labels ─────────────────────────────────────────────────────
    const rotate = rotationFor(categoryCount(out));
    let rotated = false;

    // Rotation is an x-axis rule: turning a horizontal bar chart's y-axis category labels on their
    // side would be actively wrong, so only `interval` crosses to the y axis (where it is inert on a
    // value axis and prevents silent label-skipping on a category one).
    const normalizeAxis = (axis: Record<string, unknown>, isX: boolean): Record<string, unknown> => {
        const axisLabel = isRecord(axis.axisLabel) ? { ...axis.axisLabel } : {};
        axisLabel.interval = 0;
        if (isX && rotate !== null && axisLabel.rotate === undefined) axisLabel.rotate = rotate;
        if (isX && typeof axisLabel.rotate === "number" && axisLabel.rotate !== 0) rotated = true;
        return { ...axis, axisLabel };
    };

    for (const key of ["xAxis", "yAxis"] as const) {
        const axis = out[key];
        // A malformed entry is passed through rather than dropped — normalization rewrites layout,
        // never the shape of the spec it was handed.
        if (Array.isArray(axis)) out[key] = axis.map((entry) => (isRecord(entry) ? normalizeAxis(entry, key === "xAxis") : entry));
        else if (isRecord(axis)) out[key] = normalizeAxis(axis, key === "xAxis");
    }

    // ── Grid ────────────────────────────────────────────────────────────
    const cartesian = out.xAxis !== undefined || out.yAxis !== undefined;
    const grid = out.grid;
    // An array of grids, or a grid the author sized explicitly (`width`/`height`): a margin added on
    // top of an explicit box could over-constrain it. Non-cartesian charts (pie, sunburst, graph)
    // have no grid to lay out.
    const gridNormalizable =
        cartesian && !Array.isArray(grid) && (grid === undefined || (isRecord(grid) && grid.width === undefined && grid.height === undefined));
    if (gridNormalizable) {
        const authored = isRecord(grid) ? grid : {};
        out.grid = {
            ...authored,
            ...(authored.top === undefined ? { top: out.graphic !== undefined ? "12%" : "8%" } : {}),
            ...(authored.bottom === undefined ? { bottom: rotated ? (bottomLegend ? "30%" : "25%") : "20%" } : {}),
            ...(authored.left === undefined ? { left: "10%" } : {}),
            ...(authored.right === undefined ? { right: "5%" } : {}),
        };
    }

    // ── Toolbox ─────────────────────────────────────────────────────────
    if (!Array.isArray(out.toolbox)) {
        const authored = isRecord(out.toolbox) ? out.toolbox : {};
        const feature = isRecord(authored.feature) ? authored.feature : {};
        const saveAsImage = isRecord(feature.saveAsImage) ? feature.saveAsImage : {};
        // The in-spec title is stripped, but it is still the author's own description of the chart —
        // a better filename seed than the generic fallback when no card title was given.
        const specTitleText = isRecord(specTitle) && typeof specTitle.text === "string" ? specTitle.text : undefined;

        out.toolbox = {
            ...authored,
            ...(hasPlacement(authored) ? {} : { right: 0, top: 0 }),
            feature: {
                ...feature,
                saveAsImage: {
                    ...saveAsImage,
                    ...(saveAsImage.type === undefined ? { type: "png" } : {}),
                    ...(saveAsImage.name === undefined ? { name: kebabFilename(opts.title ?? specTitleText) } : {}),
                },
            },
        };
    }

    return out;
}
