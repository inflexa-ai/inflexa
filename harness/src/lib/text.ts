/**
 * Small named text checks. Each one is exactly equivalent to the anchored
 * character-class pattern it replaced, with no calendar or semantic validation
 * beyond the character positions it names.
 */

function isAsciiDigit(code: number): boolean {
    return code >= 48 && code <= 57;
}

function isAsciiUpper(code: number): boolean {
    return code >= 65 && code <= 90;
}

function isAsciiLower(code: number): boolean {
    return code >= 97 && code <= 122;
}

function everyChar(value: string, holds: (code: number) => boolean): boolean {
    if (value.length === 0) return false;
    for (let i = 0; i < value.length; i++) {
        if (!holds(value.charCodeAt(i))) return false;
    }
    return true;
}

function someChar(value: string, holds: (code: number) => boolean): boolean {
    for (let i = 0; i < value.length; i++) {
        if (holds(value.charCodeAt(i))) return true;
    }
    return false;
}

/** Every character is `0`-`9`, and the value is not empty. */
export function isDigits(value: string): boolean {
    return everyChar(value, isAsciiDigit);
}

/** Every character is a hex digit in either case, and the value is not empty. */
export function isHex(value: string): boolean {
    return everyChar(value, (code) => isAsciiDigit(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102));
}

/** Every character is a lowercase hex digit (`0`-`9`, `a`-`f`), and the value is not empty. */
export function isLowerHex(value: string): boolean {
    return everyChar(value, (code) => isAsciiDigit(code) || (code >= 97 && code <= 102));
}

/** Every character is an ASCII letter, in either case, and the value is not empty. */
export function isAlpha(value: string): boolean {
    return everyChar(value, (code) => isAsciiUpper(code) || isAsciiLower(code));
}

/** A lowercase hex digest of length 64. */
export function isLowerHex64(value: string): boolean {
    return value.length === 64 && isLowerHex(value);
}

/** A content hash of the storage layout: `sha256:` plus 64 lowercase hex digits. */
export function isSha256Hex(value: string): boolean {
    return value.startsWith("sha256:") && isLowerHex64(value.slice(7));
}

/** The value holds at least one ASCII letter, in either case. */
export function hasLetter(value: string): boolean {
    return someChar(value, (code) => isAsciiUpper(code) || isAsciiLower(code));
}

/** The value holds at least one uppercase ASCII letter. */
export function hasUpper(value: string): boolean {
    return someChar(value, isAsciiUpper);
}

/** The value holds at least one lowercase ASCII letter. */
export function hasLower(value: string): boolean {
    return someChar(value, isAsciiLower);
}

/** The value holds at least one ASCII digit. */
export function hasDigit(value: string): boolean {
    return someChar(value, isAsciiDigit);
}

/** The first character is an ASCII digit. */
export function startsWithDigit(value: string): boolean {
    return isAsciiDigit(value.charCodeAt(0));
}

/** The first character is an ASCII letter, in either case. */
export function startsWithLetter(value: string): boolean {
    const code = value.charCodeAt(0);
    return isAsciiUpper(code) || isAsciiLower(code);
}

/** A CSS hex color: `#` plus six lowercase hex digits. */
export function isHexColor(value: string): boolean {
    return value.length === 7 && value[0] === "#" && isLowerHex(value.slice(1));
}

/** The `YYYY-MM-DD` character positions. This reads the layout only — it does not validate the calendar. */
export function isIsoDate(value: string): boolean {
    return (
        value.length === 10 &&
        isDigits(value.slice(0, 4)) &&
        value[4] === "-" &&
        isDigits(value.slice(5, 7)) &&
        value[7] === "-" &&
        isDigits(value.slice(8, 10))
    );
}

/** The UUID layout: 8-4-4-4-12 hex digits in either case, separated by hyphens. */
export function isUuid(value: string): boolean {
    return (
        value.length === 36 &&
        isHex(value.slice(0, 8)) &&
        value[8] === "-" &&
        isHex(value.slice(9, 13)) &&
        value[13] === "-" &&
        isHex(value.slice(14, 18)) &&
        value[18] === "-" &&
        isHex(value.slice(19, 23)) &&
        value[23] === "-" &&
        isHex(value.slice(24))
    );
}

/** Split text into lines, accepting CRLF and LF endings. */
export function splitLines(text: string): string[] {
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- delimiter-set split: LF with an optional CR — no string method separates both endings in one call.
    return text.split(/\r?\n/);
}
