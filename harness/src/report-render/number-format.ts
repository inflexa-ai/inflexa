/**
 * The number format of a resolved value.
 *
 * The renderer shows a number in one of five kinds. `scientific` gives a coefficient of two significant
 * digits and an exponent, for example `4.3e-5`. `compact` gives an integer with comma grouping, for example
 * `14,201`. `compact-scientific` gives three significant digits, for example `−3.09`. It gives a grouped
 * whole number for a magnitude from `1e3` to `1e15`, for example `15,235`, and it falls to the scientific
 * form under one thousandth and from `1e15` up. `identifier` gives the source text. `below-resolution`
 * gives a bound over a stored zero, for example `<4e-4`, or `<0.02` where the column is coarse.
 *
 * The module reads no locale. `toLocaleString` gives different text on a different host, thus the render
 * function would stop being a pure function of its inputs. The comma grouping is written here for that
 * reason.
 *
 * A shown form hides digits when it no longer parses back to the value, or when it no longer matches the
 * source text of a string cell. The caller puts the full digits in the `title` attribute at that time, and
 * it emits no attribute at any other time.
 *
 * The column meaning that a binding declares replaces the name of the column in the kind decision. The
 * magnitude of the cell decides after it, the same for a declared column and for an undeclared one.
 *
 * A table resolves one kind for each whole column with `selectColumnKind`, and the data asset ships that
 * kind. `formatTableCell` then reads the cell under it. The page script holds a twin of that one function,
 * and a shared test vector pins the two together.
 *
 * `holdsADriftedExponent` reads one written form against the same rules. A prose sentence can state an
 * exponent in a notation that no shown form gives. Such a sentence drifts from the page, and the advisory
 * scan of a draft reports it.
 */

import type { ColumnMeaning } from "../contracts/report-reference.js";

/** The five number kinds that the renderer shows. */
export type NumberKind = "scientific" | "compact" | "compact-scientific" | "identifier" | "below-resolution";

/** One formatted cell. `full` holds the full digits, and it is present only when `text` hides one. */
export interface FormattedNumber {
    readonly text: string;
    readonly full?: string;
}

/** The significant digits of the scientific coefficient, for example the two digits of `4.3e-5`. */
const SCIENTIFIC_DIGITS = 2;

/** The significant digits of the compact-scientific form, for example the three digits of `-3.09`. */
const COMPACT_DIGITS = 3;

/** The magnitude under which a p-value column selects the scientific kind. */
const SCIENTIFIC_FLOOR = 1e-2;

/**
 * The exponent from which the bound of a stored zero reads as a plain decimal. It is the exponent of
 * `SCIENTIFIC_FLOOR`, thus a bound and the values around it read in one notation.
 */
const PLAIN_BOUND_EXPONENT = -2;

/** The magnitude under which the compact-scientific form falls to the scientific form. */
const COMPACT_SCIENTIFIC_FLOOR = 1e-3;

/** The rounded magnitude from which the compact-scientific form gives a grouped whole number. */
const GROUPED_FLOOR = 1e3;

/** The rounded magnitude from which the grouped whole number gives way to the scientific form. */
const GROUPED_CEILING = 1e15;

/** The size of one grouped digit run, for example the three digits of `14,201`. */
const GROUP_SIZE = 3;

/**
 * The whole tokens of a column name that name a p-value. Such a value reads better in the scientific form.
 *
 * The tokens are the fallback for a column that declares no meaning. A declaration states what the column
 * is, and a name only suggests it. Thus a token match answers where the author declared nothing.
 */
const P_VALUE_TOKENS = new Set(["p", "pval", "pvalue", "padj", "fdr", "q", "qval"]);

/** The whole tokens of a column name that name an identifier. Such a value is a name, not a magnitude. */
const IDENTIFIER_TOKENS = new Set(["id", "pmid", "doi", "entrez", "taxid", "year", "accession"]);

/** The boundary between a lowercase or numeric character and an uppercase character. */
const CASE_BOUNDARY = /([a-z0-9])([A-Z])/g;

/** The separators of a column name: whitespace, an underscore, a point, and a hyphen. */
const SEPARATORS = /[\s_.-]+/;

/** A text that holds decimal digits alone. */
const DIGIT_RUN = /^[0-9]+$/;

/** Each group comma of a compact form. */
const GROUP_COMMAS = /,/g;

/** The exponent of one written or shown form, for example the `-05` of `4.3e-05`. */
const EXPONENT_PART = /[eE]([+-]?\d+)$/;

/**
 * The form of a stored zero that no positive neighbor bounds. It claims nearness, and it claims no bound,
 * because the column gives nothing better.
 */
const NEAR_ZERO_FORM = "≈0";

/**
 * The minus of a shown form. It is the character that a preset axis title carries, thus a card, a cell, and
 * an axis of one page read one glyph.
 */
const TYPOGRAPHIC_MINUS = "−";

/** The delimiter of an encoded set name, for example `HALLMARK_HYPOXIA%MSigDB%M5891`. */
const NAME_DELIMITER = "%";

/** The count of segments that an encoded set name holds: the name, the collection, and the accession. */
const NAME_SEGMENTS = 3;

/** One whitespace character. A segment of an encoded name holds none. */
const WHITESPACE = /\s/;

/**
 * Format one cell in one kind.
 *
 * A cell that holds no finite number passes through as its own text, and it carries no full form. A finite
 * number formats in the kind, and it carries the full digits only when the shown text loses one.
 *
 * `bound` is the smallest positive value of the column that the cell sits in. It answers the
 * below-resolution kind alone, and the caller reads the column one time to get it. Thus this function stays
 * a pure function of its arguments, and it never reads a column.
 */
export function formatNumberCell(cell: string | number, kind: NumberKind, bound?: number): FormattedNumber {
    if (kind === "identifier") {
        // An identifier is a name that is written with digits. A group comma and a rounded digit both break
        // the name, thus each character of the source reaches the page.
        return { text: String(cell).trim() };
    }
    if (kind === "below-resolution") {
        // The shown text carries no digit of the cell, thus the raw cell rides the full form in both arms.
        const text = bound !== undefined && bound > 0 ? `<${boundForm(bound)}` : NEAR_ZERO_FORM;
        return { text, full: String(cell).trim() };
    }
    const value = finiteValue(cell);
    if (value === null) {
        return { text: String(cell) };
    }
    const text = shownMinus(formatValue(value, kind));
    if (typeof cell === "string") {
        // A string cell carries its own digits already, thus the source text is the truer full form. A
        // comparison of the two texts also catches a loss that a comparison of two numbers cannot see, for
        // example the leading zero of `007` and the trailing zero of `1.50`.
        const source = cell.trim();
        return ungrouped(text) === source ? { text } : { text, full: source };
    }
    return hidesDigits(text, value) ? { text, full: String(cell) } : { text };
}

/**
 * Select the number kind for one cell of one column.
 *
 * A declaration replaces the name of the column, and the magnitude decides after it exactly as it does for
 * a name match. Thus a declared p-value column gives the same bytes as a p-value column that the tokens
 * match: `3.8e-7` takes the scientific form, and `0.536` stays `0.536`.
 *
 * An identifier column selects the identifier kind. A zero of a p-value column selects the below-resolution
 * kind. A p-value column selects the scientific kind for a value between zero and one hundredth. A safe
 * integer selects the compact kind. Every other finite number selects the compact-scientific kind. A cell
 * that holds no finite number selects the compact-scientific kind too, because the format passes such a
 * cell through unchanged.
 */
export function selectNumberKind(column: string, cell: string | number, meaning?: ColumnMeaning): NumberKind {
    if (holdsAName(column, meaning)) {
        return "identifier";
    }
    const value = finiteValue(cell);
    if (value === null) {
        return "compact-scientific";
    }
    // A stored zero in a p-value column claims no zero probability. It states that the estimator bottomed
    // out, for example a permutation count that bounds the smallest value that it can report. Thus the page
    // shows a bound, and a bare `0` would read as a result.
    if (value === 0 && holdsAPValue(column, meaning)) {
        return "below-resolution";
    }
    // From one hundredth up, the plain decimal is as short as the exponent and it is easier to read. Thus
    // `0.05` stays `0.05` and it does not become `5e-2`.
    if (value > 0 && value < SCIENTIFIC_FLOOR && holdsAPValue(column, meaning)) {
        return "scientific";
    }
    // An integer above the safe range is no longer exact, thus it reads as a general float and not as a count.
    if (Number.isSafeInteger(value)) {
        return "compact";
    }
    return "compact-scientific";
}

/**
 * The number kind of one whole column.
 *
 * A column carries one kind, and the cell decides the arms under it. `identifier` names a column of names.
 * `scientific` names a column of probabilities, where a small value reads as an exponent and a stored zero
 * reads as a bound. `compact-scientific` names every other column, where a whole number groups and a float
 * rounds.
 *
 * The renderer ships this kind with the table data, and the page formats each cell under it. Thus the
 * declaration and the token guess stay here, on the server, where a test reads them.
 */
export function selectColumnKind(column: string, meaning?: ColumnMeaning): NumberKind {
    if (holdsAName(column, meaning)) {
        return "identifier";
    }
    return holdsAPValue(column, meaning) ? "scientific" : "compact-scientific";
}

/**
 * The shown text of one table cell, under the kind of its column.
 *
 * The page script holds a twin of this function, because the rows reach the reader through the data asset
 * and the page formats them there. A shared test vector runs both over the same entries, thus the two
 * cannot give different text in silence.
 *
 * `bound` is the smallest positive value of the column. A stored zero of a probability column reads as a
 * bound under it, thus the page never prints a probability of zero.
 *
 * A delimited name shows its first segment. Such a name holds no finite number, thus the number format
 * passes it through and this trim reads the text that the format gave.
 */
export function formatTableCell(cell: string | number, kind: NumberKind, bound?: number): string {
    const shown = formatNumberCell(cell, cellKind(cell, kind), bound).text;
    return firstNameSegment(shown) ?? shown;
}

/**
 * The kind of one cell under the kind of its column.
 *
 * A column of names gives one kind to each of its cells. A column of magnitudes reads the cell: a zero of a
 * probability column takes the bound, a small probability takes the exponent, a safe integer takes the
 * grouped form, and every other value takes the rounded form. A cell that holds no finite number takes the
 * rounded form too, because the format passes such a cell through unchanged.
 */
function cellKind(cell: string | number, column: NumberKind): NumberKind {
    if (column === "identifier") {
        return "identifier";
    }
    const value = finiteValue(cell);
    if (value === null) {
        return "compact-scientific";
    }
    if (column === "scientific") {
        // A stored zero in a probability column claims no zero probability. It states that the estimator
        // bottomed out, thus the page shows a bound and a bare `0` would read as a result.
        if (value === 0) {
            return "below-resolution";
        }
        // From one hundredth up, the plain decimal is as short as the exponent and it is easier to read.
        if (value > 0 && value < SCIENTIFIC_FLOOR) {
            return "scientific";
        }
    }
    // An integer above the safe range is no longer exact, thus it reads as a general float and not as a count.
    return Number.isSafeInteger(value) ? "compact" : "compact-scientific";
}

/**
 * The first segment of a delimited name, or `undefined` when the text carries no delimited name.
 *
 * An enrichment tool joins the name of a set, its collection, and its accession with a percent sign. The
 * name alone identifies the row, thus the rest is noise inside a narrow column.
 *
 * Such a name holds three or more segments, each segment holds a character, and no segment holds a
 * whitespace character. Every other text keeps its whole form. Thus `95%` stays whole, and a sentence such
 * as `up 20% vs control` stays whole.
 */
function firstNameSegment(text: string): string | undefined {
    const segments = text.split(NAME_DELIMITER);
    if (segments.length < NAME_SEGMENTS) {
        return undefined;
    }
    const encoded = segments.every((segment) => segment.length > 0 && !WHITESPACE.test(segment));
    return encoded ? segments[0] : undefined;
}

/**
 * True when the column holds a name and not a magnitude.
 *
 * A declared `identifier` and a declared `category` both hold one. The identifier kind is the one kind that
 * gives the source text unchanged, thus a category that reads as a number keeps its own text, for example
 * the cluster `01`. A column that declares no meaning falls to the name tokens.
 */
function holdsAName(column: string, meaning: ColumnMeaning | undefined): boolean {
    if (meaning !== undefined) {
        return meaning === "identifier" || meaning === "category";
    }
    return isIdentifierColumn(column);
}

/**
 * True when the column holds a probability. A column that declares no meaning falls to the name tokens.
 *
 * A declared `effect` and a declared `count` both hold a magnitude, thus each one takes the magnitude arms
 * below this test. An effect is a float, and it reads there in the compact-scientific kind. A count is a
 * whole number, and it reads there in the compact kind.
 *
 * The kind of a cell and the kind of a whole column both read this, thus a probability column takes the
 * scientific kind and the zeros of that column take a bound.
 */
function holdsAPValue(column: string, meaning?: ColumnMeaning): boolean {
    return meaning !== undefined ? meaning === "p-value" : isPValueColumn(column);
}

/**
 * True when one cell of a column parses as a finite number.
 *
 * The filter of a column reads this. One value that parses keeps the column numeric, thus a sentinel such
 * as `NA` beside the numbers cannot drop the column to the text filter. A column where no cell parses holds
 * names, and a name filters as text.
 */
export function holdsANumber(cells: readonly (string | number | undefined)[]): boolean {
    for (const cell of cells) {
        if (cell !== undefined && finiteValue(cell) !== null) {
            return true;
        }
    }
    return false;
}

/**
 * The smallest positive value of one column, or `undefined` when the column holds none.
 *
 * The value bounds a stored zero of the same column from above. A cell that holds no finite number, and a
 * cell that is not positive, both give no bound.
 */
export function smallestPositiveValue(cells: readonly (string | number | undefined)[]): number | undefined {
    let smallest: number | undefined;
    for (const cell of cells) {
        if (cell === undefined) continue;
        const value = finiteValue(cell);
        if (value === null || value <= 0) continue;
        if (smallest === undefined || value < smallest) smallest = value;
    }
    return smallest;
}

/**
 * True when one written form states an exponent that no shown form of this module gives.
 *
 * A shown exponent comes out of `tidy` in every kind that prints one, thus it carries no plus sign and no
 * leading zero. A written form such as `4.3e-05` states the same value in a notation that the page never
 * prints. Thus the prose and the page read differently for one number.
 *
 * The test reads the shown form of the same value and compares the two exponents. Thus it follows the
 * printer, and it repeats none of the rules of the printer. The mantissa stays out of the comparison,
 * because the digits of a written value are a matter of rounding and not of notation.
 *
 * A text that carries no exponent, and a text that holds no finite number, both give false.
 */
export function holdsADriftedExponent(text: string): boolean {
    const written = EXPONENT_PART.exec(text.trim());
    if (written === null) {
        return false;
    }
    const value = finiteValue(text);
    if (value === null) {
        return false;
    }
    const shown = EXPONENT_PART.exec(formatNumberCell(value, "scientific").text);
    return shown !== null && shown[1] !== written[1];
}

/**
 * The bound of a stored zero, as one significant digit that rounds up, for example `4e-4` from `0.00036`.
 *
 * The rounding reads the decimal text and never the binary value. `toExponential` gives the shortest text
 * that names the value again, thus a mantissa of one digit names the neighbor exactly, and any other
 * mantissa holds something under the first digit. A round to the nearest digit would fall under the
 * neighbor and state a bound that is false. Thus the first digit goes up by one wherever a digit follows
 * it, and a digit that reaches ten carries into the exponent.
 *
 * From `PLAIN_BOUND_EXPONENT` up the bound reads as a plain decimal. A coarse estimator gives a bound
 * beside values that the scientific floor leaves as plain decimals, and one column must read in one
 * notation. Thus `<0.02` stands beside `0.04`, and no bound gives an exponent of zero.
 */
function boundForm(bound: number): string {
    const [mantissa, exponent] = bound.toExponential().split("e");
    const digits = mantissa.replace(".", "");
    const raised = Number(digits[0]) + (digits.length > 1 ? 1 : 0);
    const carries = raised === 10;
    const digit = carries ? 1 : raised;
    const power = Number(exponent) + (carries ? 1 : 0);
    if (power < PLAIN_BOUND_EXPONENT) {
        return `${digit}e${power}`;
    }
    // The decimal text builds from the digit and the exponent, thus no float arithmetic can shift it.
    return power >= 0 ? `${digit}${"0".repeat(power)}` : `0.${"0".repeat(-power - 1)}${digit}`;
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

/**
 * The text of one finite value in one kind. The identifier kind and the below-resolution kind both give a
 * text that carries no digit of the value, thus both are absent here.
 */
function formatValue(value: number, kind: Exclude<NumberKind, "identifier" | "below-resolution">): string {
    switch (kind) {
        case "scientific":
            return scientificForm(value);
        case "compact":
            return compactForm(value);
        case "compact-scientific": {
            const magnitude = Math.abs(value);
            if (value !== 0 && magnitude < COMPACT_SCIENTIFIC_FLOOR) {
                return scientificForm(value);
            }
            // Above three significant digits `toPrecision` crosses to the exponential form, and `1.52e4`
            // reads worse than `15,235`. The grouped form holds up to the width where a group run stops
            // being easy to count.
            const rounded = Math.round(magnitude);
            if (rounded >= GROUPED_FLOOR && rounded < GROUPED_CEILING) {
                return compactForm(value);
            }
            return tidy(value.toPrecision(COMPACT_DIGITS));
        }
    }
}

/**
 * One shown form with the sign of its value as the typographic minus.
 *
 * The substitution reads the leading character alone. Thus the exponent of a form such as `-1.2e-4` keeps
 * its own hyphen, and a reader of that exponent reads the notation that the module prints.
 *
 * The shown form then no longer parses back to the value, thus the caller carries the raw cell in the full
 * form. A negative always names its stored digits beside the glyph.
 */
function shownMinus(text: string): string {
    return text.startsWith("-") ? TYPOGRAPHIC_MINUS + text.slice(1) : text;
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

/** One shown form without its group commas, thus the grouping alone never counts as a hidden digit. */
function ungrouped(text: string): string {
    return text.replace(GROUP_COMMAS, "");
}

/** True when the shown text no longer parses back to the value. */
function hidesDigits(text: string, value: number): boolean {
    return Number(ungrouped(text)) !== value;
}

/** True when one whole token of the column name names a p-value. A bare substring never matches. */
function isPValueColumn(column: string): boolean {
    return columnTokens(column).some((token) => P_VALUE_TOKENS.has(token));
}

/** True when one whole token of the column name names an identifier. A bare substring never matches. */
function isIdentifierColumn(column: string): boolean {
    return columnTokens(column).some((token) => IDENTIFIER_TOKENS.has(token));
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
