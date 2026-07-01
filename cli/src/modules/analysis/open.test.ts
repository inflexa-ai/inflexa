import { describe, expect, test } from "bun:test";

import { openerArgv } from "./open.ts";

describe("openerArgv", () => {
    test("uses `open` on macOS", () => {
        expect(openerArgv("/d", "darwin")).toEqual(["open", "/d"]);
    });

    test("uses `cmd /c start` with the empty title arg on Windows", () => {
        // The "" is the START title argument — without it, a quoted dir would be taken as the title.
        expect(openerArgv("/d", "win32")).toEqual(["cmd", "/c", "start", "", "/d"]);
    });

    test("uses `xdg-open` on Linux and other platforms", () => {
        expect(openerArgv("/d", "linux")).toEqual(["xdg-open", "/d"]);
    });
});
