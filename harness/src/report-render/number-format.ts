/**
 * The number format of a resolved value.
 *
 * The renderer shows a number in one of three kinds. `scientific` gives a coefficient of two significant
 * digits and an exponent, for example `4.3e-5`. `compact` gives an integer with comma grouping, for example
 * `14,201`. `compact-scientific` gives three significant digits, for example `-3.09`, and it falls to the
 * scientific form for a magnitude under one thousandth.
 *
 * The module reads no locale. `toLocaleString` gives different text on a different host, thus the render
 * function would stop being a pure function of its inputs. The comma grouping is written here for that
 * reason.
 *
 * A shown form hides digits when it no longer parses back to the value. The caller puts the full digits in
 * the `title` attribute at that time, and it emits no attribute at any other time.
 */

/** The three number kinds that the renderer shows. */
export type NumberKind = "scientific" | "compact" | "compact-scientific";

/** One formatted cell. `full` holds the full digits, and it is present only when `text` hides one. */
export interface FormattedNumber {
    readonly text: string;
    readonly full?: string;
}

/** The significant digits of the scientific coefficient, for example the two digits of `4.3e-5`. */
const SCIENTIFIC_DIGITS = 2;

/** The significant digits of the compact-scientific form, for example the three digits of `-3.09`. */
const COMPACT_DIGITS = 3;

/** The magnitude under which the compact-scientific form falls to the scientific form. */
const SCIENTIFIC_FLOOR = 1e-3;

/** The size of one grouped digit run, for example the three digits of `14,201`. */
const GROUP_SIZE = 3;

/** The whole tokens of a column name that name a p-value. Such a value reads better in the scientific form. */
const P_VALUE_TOKENS = new Set(["p", "pval", "pvalue", "padj", "fdr", "q", "qval"]);

/** The boundary between a lowercase or numeric character and an uppercase character. */
const CASE_BOUNDARY = /([a-z0-9])([A-Z])/g;

/** The separators of a column name: whitespace, an underscore, a point, and a hyphen. */
const SEPARATORS = /[\s_.-]+/;

/** A text that holds decimal digits alone. */
const DIGIT_RUN = /^[0-9]+$/;

/** Each group comma of a compact form. */
const GROUP_COMMAS = /,/g;

/**
 * Format one cell in one kind.
 *
 * A cell that holds no finite number passes through as its own text, and it carries no full form. A finite
 * number formats in the kind, and it carries the full digits only when the shown text parses back to a
 * different number.
 */
export function formatNumberCell(cell: string | number, kind: NumberKind): FormattedNumber {
    const value = finiteValue(cell);
    if (value === null) {
        return { text: String(cell) };
    }
    const text = formatValue(value, kind);
    if (!hidesDigits(text, value)) {
        return { text };
    }
    // A string cell carries its own digits already. Thus the original text is the truer full form, because
    // a round trip through a number can drop a trailing zero that the source held.
    return { text, full: typeof cell === "string" ? cell.trim() : String(cell) };
}

/**
 * Select the number kind for one cell of one column.
 *
 * A p-value column selects the scientific kind for a value between zero and one. A safe integer selects the
 * compact kind. Every other finite number selects the compact-scientific kind. A cell that holds no finite
 * number selects the compact-scientific kind too, because the format passes such a cell through unchanged.
 */
export function selectNumberKind(column: string, cell: string | number): NumberKind {
    const value = finiteValue(cell);
    if (value === null) {
        return "compact-scientific";
    }
    if (value > 0 && value < 1 && isPValueColumn(column)) {
        return "scientific";
    }
    // An integer above the safe range is no longer exact, thus it reads as a general float and not as a count.
    if (Number.isSafeInteger(value)) {
        return "compact";
    }
    return "compact-scientific";
}

/** The finite number of one cell, or `null` when the cell holds no finite number. */
function finiteValue(cell: string | number): number | null {
    if (typeof cell === "number") {
        return Number.isFinite(cell) ? cell : null;
    }
    const trimmed = cell.trim();
    if (trimmed === "") {
        return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}

/** The text of one finite value in one kind. */
function formatValue(value: number, kind: NumberKind): string {
    switch (kind) {
        case "scientific":
            return scientificForm(value);
        case "compact":
            return compactForm(value);
        case "compact-scientific":
            if (value !== 0 && Math.abs(value) < SCIENTIFIC_FLOOR) {
                return scientificForm(value);
            }
            return tidy(value.toPrecision(COMPACT_DIGITS));
    }
}

/** The scientific form, for example `4.3e-5`. */
function scientificForm(value: number): string {
    return tidy(value.toExponential(SCIENTIFIC_DIGITS - 1));
}

/** The integer form with comma grouping, for example `14,201`. The sign stays in front of the groups. */
function compactForm(value: number): string {
    const sign = value < 0 ? "-" : "";
    return sign + groupDigits(Math.abs(value).toFixed(0));
}

/**
 * Insert one comma before each group of three digits. A text that is not a plain digit run passes through,
 * thus a magnitude that `toFixed` gives in the exponential form stays whole.
 */
function groupDigits(digits: string): string {
    if (!DIGIT_RUN.test(digits)) {
        return digits;
    }
    let grouped = "";
    for (let index = 0; index < digits.length; index += 1) {
        if (index > 0 && (digits.length - index) % GROUP_SIZE === 0) {
            grouped += ",";
        }
        grouped += digits[index];
    }
    return grouped;
}

/**
 * Trim the noise from one numeric form: the trailing zeros of the fraction, the decimal point that they
 * leave bare, and the plus sign of a positive exponent.
 */
function tidy(text: string): string {
    const marker = text.indexOf("e");
    if (marker < 0) {
        return trimTrailingZeros(text);
    }
    const mantissa = trimTrailingZeros(text.slice(0, marker));
    const exponent = text.slice(marker + 1).replace("+", "");
    return `${mantissa}e${exponent}`;
}

/** Drop the trailing zeros of a decimal fraction, and the decimal point that they leave bare. */
function trimTrailingZeros(text: string): string {
    if (!text.includes(".")) {
        return text;
    }
    let end = text.length;
    while (end > 0 && text[end - 1] === "0") {
        end -= 1;
    }
    if (text[end - 1] === ".") {
        end -= 1;
    }
    return text.slice(0, end);
}

/**
 * True when the shown text no longer parses back to the value. The comparison drops the group commas
 * first, thus the grouping alone never counts as a hidden digit.
 */
function hidesDigits(text: string, value: number): boolean {
    return Number(text.replace(GROUP_COMMAS, "")) !== value;
}

/** True when one whole token of the column name names a p-value. A bare substring never matches. */
function isPValueColumn(column: string): boolean {
    return columnTokens(column).some((token) => P_VALUE_TOKENS.has(token));
}

/**
 * The lowercase tokens of a column name. A separator and a case boundary both end a token, thus `padjBH`
 * gives `padj` and `bh`, and `p_value` gives `p` and `value`.
 */
function columnTokens(column: string): string[] {
    return column
        .replace(CASE_BOUNDARY, "$1 $2")
        .split(SEPARATORS)
        .filter((token) => token.length > 0)
        .map((token) => token.toLowerCase());
}
