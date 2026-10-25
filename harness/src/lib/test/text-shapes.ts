/**
 * Text shapes that the test files of several module families assert: the lowercase
 * hex digest family, the tool-output reference, the six-digit hex color, and the
 * paired-surrogate invariants of cut text. Each predicate reads the string with the
 * string methods and the char codes, so no pattern lives here.
 */

function isLowerHex(text: string): boolean {
    return [...text].every((char) => (char >= "0" && char <= "9") || (char >= "a" && char <= "f"));
}

/** Whether `text` is exactly `length` lowercase hex characters. */
export function isLowerHexOfLength(text: string, length: number): boolean {
    return text.length === length && isLowerHex(text);
}

/** Whether `text` is a `sha256:` content hash over a 64-digit lowercase hex digest. */
export function isSha256Hash(text: string): boolean {
    return text.startsWith("sha256:") && isLowerHexOfLength(text.slice("sha256:".length), 64);
}

/** Whether `text` is a tool-output reference: `to_` over 20 lowercase hex characters. */
export function isToolOutputRef(text: string): boolean {
    return text.startsWith("to_") && isLowerHexOfLength(text.slice("to_".length), 20);
}

/**
 * The tool-output reference that a cut-result marker names, or undefined when the text
 * names none. The marker reads `reference "to_<20 hex>"`, and the reference ends at its
 * closing quote.
 */
export function referencedToolOutput(text: string): string | undefined {
    const opener = 'reference "';
    const at = text.indexOf(opener);
    if (at < 0) return undefined;
    const start = at + opener.length;
    const ref = text.slice(start, start + "to_".length + 20);
    if (!isToolOutputRef(ref) || text.charAt(start + ref.length) !== '"') return undefined;
    return ref;
}

/** Whether `text` is an RGB color in the six-digit lowercase hex form: `#1a2b3c`. */
export function isHexColor(text: string): boolean {
    return text.startsWith("#") && isLowerHexOfLength(text.slice(1), 6);
}

function isHighSurrogate(unit: number): boolean {
    return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
    return unit >= 0xdc00 && unit <= 0xdfff;
}

/** Whether `text` holds a high surrogate that no low surrogate follows. */
export function hasLoneHighSurrogate(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
        if (isHighSurrogate(text.charCodeAt(i)) && !isLowSurrogate(text.charCodeAt(i + 1))) return true;
    }
    return false;
}

/** Whether `text` holds a low surrogate that no high surrogate precedes. */
export function hasLoneLowSurrogate(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
        if (isLowSurrogate(text.charCodeAt(i)) && !isHighSurrogate(text.charCodeAt(i - 1))) return true;
    }
    return false;
}
