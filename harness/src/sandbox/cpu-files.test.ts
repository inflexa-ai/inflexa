/**
 * `cpuFiles` is pure: the content of the two cpu files from a thread count and
 * the text of a real `/proc/cpuinfo`.
 */

import { describe, expect, test } from "bun:test";

import { cpuFiles } from "./cpu-files.js";

function block(n: number): string {
    return `processor\t: ${n}\nvendor_id\t: GenuineIntel\nmodel name\t: Test CPU\ncpu MHz\t\t: 2400.000\nflags\t\t: fpu vme\n`;
}

/** Four processor blocks in the x86 layout: a blank line after each block. */
const HOST_CPUINFO = [0, 1, 2, 3].map((n) => `${block(n)}\n`).join("");

function processorCount(cpuinfo: string): number {
    return cpuinfo.match(/^processor\b/gm)?.length ?? 0;
}

describe("cpuFiles", () => {
    test("two threads: online is the range 0-1 and cpuinfo keeps the first two blocks", () => {
        const files = cpuFiles(2, HOST_CPUINFO);

        expect(files.online).toBe("0-1\n");
        expect(files.cpuinfo).toBe(`${block(0)}\n${block(1)}\n`);
        expect(processorCount(files.cpuinfo!)).toBe(2);
    });

    test("one thread: online is `0`, as the kernel writes it for a single cpu", () => {
        const files = cpuFiles(1, HOST_CPUINFO);

        expect(files.online).toBe("0\n");
        expect(processorCount(files.cpuinfo!)).toBe(1);
        expect(files.cpuinfo).toStartWith("processor\t: 0\n");
    });

    test("more threads than host blocks: all blocks stay", () => {
        const files = cpuFiles(8, HOST_CPUINFO);

        expect(files.online).toBe("0-7\n");
        expect(processorCount(files.cpuinfo!)).toBe(4);
    });

    test("a block with no processor line is not a processor", () => {
        // An ARM kernel ends the file with a trailer that names the board.
        const arm = `${HOST_CPUINFO}Hardware\t: Test Board\nRevision\t: 0001\n`;

        const files = cpuFiles(8, arm);

        expect(processorCount(files.cpuinfo!)).toBe(4);
        expect(files.cpuinfo).not.toContain("Hardware");
    });

    test("no host cpuinfo: online only", () => {
        const files = cpuFiles(3, undefined);

        expect(files.online).toBe("0-2\n");
        expect(files.cpuinfo).toBeUndefined();
    });
});
