/**
 * Whitespace normalization for fetched regulatory document text (HTML bodies and PDF
 * extractions): space and tab runs collapse to one space, newline runs cap at one blank
 * line, and the edges trim.
 */
export function normalizeWhitespace(s: string): string {
    let out = "";
    let inSpaceRun = false;
    let newlineRun = 0;
    const flushNewlineRun = (): void => {
        out += "\n".repeat(Math.min(newlineRun, 2));
        newlineRun = 0;
    };
    for (const char of s) {
        // A CR joins the newline run it sits in — a CRLF pair merges through it, it never
        // ends the run — and with no run pending it only ends a space run.
        if (char === "\r") {
            inSpaceRun = false;
            continue;
        }
        if (char === "\n") {
            inSpaceRun = false;
            newlineRun += 1;
            continue;
        }
        if (char === " " || char === "\t") {
            if (newlineRun > 0) flushNewlineRun();
            if (!inSpaceRun) out += " ";
            inSpaceRun = true;
            continue;
        }
        if (newlineRun > 0) flushNewlineRun();
        inSpaceRun = false;
        out += char;
    }
    flushNewlineRun();
    return out.trim();
}
