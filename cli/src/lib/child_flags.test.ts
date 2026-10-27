import { describe, expect, test } from "bun:test";

import type { Command } from "commander";

import { buildProgram } from "../cli/index.ts";
import {
    CATALOG_TRANSFER_FLAG,
    CLIENT_START_FLAG,
    IMAGE_TRANSFER_FLAG,
    isSelfStartedChild,
    SERVE_DETACHED_CHILD_FLAG,
    STORE_FLUSH_FLAG,
    WALK_COMMAND,
} from "./child_flags.ts";

describe("isSelfStartedChild", () => {
    test("names each child that the CLI starts for itself, with the argv of its spawn site", () => {
        expect(isSelfStartedChild(["serve", SERVE_DETACHED_CHILD_FLAG])).toBe(true);
        expect(isSelfStartedChild(["serve", "--detach", CLIENT_START_FLAG])).toBe(true);
        expect(isSelfStartedChild(["sandbox", "pull", IMAGE_TRANSFER_FLAG, "runtime_image"])).toBe(true);
        expect(isSelfStartedChild(["store", "download", CATALOG_TRANSFER_FLAG])).toBe(true);
        expect(isSelfStartedChild(["store", "download", "--update", CATALOG_TRANSFER_FLAG])).toBe(true);
        expect(isSelfStartedChild(["store", "add", STORE_FLUSH_FLAG])).toBe(true);
        expect(isSelfStartedChild([...WALK_COMMAND, "/data", "--depth", "64"])).toBe(true);
    });

    test("a command of a person is not such a child", () => {
        expect(isSelfStartedChild(["ls"])).toBe(false);
        expect(isSelfStartedChild([])).toBe(false);
        expect(isSelfStartedChild(["serve"])).toBe(false);
        expect(isSelfStartedChild(["serve", "--detach"])).toBe(false);
        expect(isSelfStartedChild(["store", "add", "numpy", "--queued"])).toBe(false);
        expect(isSelfStartedChild(["up"])).toBe(false);
        expect(isSelfStartedChild(["server", "status"])).toBe(false);
        expect(isSelfStartedChild(["walk", "server"])).toBe(false);
    });
});

describe("the registry", () => {
    function command(path: readonly string[]): Command | undefined {
        let current: Command | undefined = buildProgram();
        for (const name of path) current = current?.commands.find((c) => c.name() === name);
        return current;
    }

    function longs(path: readonly string[]): (string | undefined)[] {
        return command(path)?.options.map((option) => option.long) ?? [];
    }

    test("declares each hidden child flag on the command that its spawn site runs", () => {
        expect(longs(["serve"])).toContain(SERVE_DETACHED_CHILD_FLAG);
        expect(longs(["serve"])).toContain(CLIENT_START_FLAG);
        expect(longs(["sandbox", "pull"])).toContain(IMAGE_TRANSFER_FLAG);
        expect(longs(["store", "download"])).toContain(CATALOG_TRANSFER_FLAG);
        expect(longs(["store", "add"])).toContain(STORE_FLUSH_FLAG);
        expect(command(WALK_COMMAND)).toBeDefined();
    });
});
