import { replaceProperty } from "./replace_property.ts";

/**
 * Fake `process.stderr` as a terminal (`isTTY` true) or a pipe (`isTTY` false) until the end of the
 * current test, and give back the live list of each chunk that is written to it.
 */
export function fakeStderr(isTTY: boolean): string[] {
    const written: string[] = [];
    replaceProperty(process.stderr, "isTTY", isTTY);
    replaceProperty(process.stderr, "write", (chunk: string | Uint8Array): boolean => {
        written.push(String(chunk));
        return true;
    });
    return written;
}
