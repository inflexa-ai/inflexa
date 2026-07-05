import { describe, expect, test } from "bun:test";

import { archFromMachine, ARCHES, detectArch, DOCKER_PLATFORM, TRACK_SUBTREE } from "./arch.ts";

describe("archFromMachine", () => {
    test("maps x86_64 / amd64 to linux-amd64", () => {
        expect(archFromMachine("x86_64")).toBe("linux-amd64");
        expect(archFromMachine("amd64\n")).toBe("linux-amd64");
    });

    test("maps aarch64 / arm64 to linux-arm64", () => {
        expect(archFromMachine("aarch64")).toBe("linux-arm64");
        expect(archFromMachine("ARM64")).toBe("linux-arm64");
    });

    test("returns null for an unrecognized machine", () => {
        expect(archFromMachine("riscv64")).toBeNull();
    });
});

describe("detectArch", () => {
    test("never throws and agrees with archFromMachine(`uname -m`)", () => {
        // detectArch spawns `uname -m` and folds a failed spawn onto the same null as an
        // unrecognized machine, so the only stable contract is agreement with the pure mapper.
        const machine = Bun.spawnSync(["uname", "-m"]).stdout.toString();
        expect(detectArch()).toBe(archFromMachine(machine));
    });
});

describe("TRACK_SUBTREE", () => {
    test("maps every track to the fixed subtree the resolver env hard-codes", () => {
        expect(TRACK_SUBTREE.cran).toBe("r/cran");
        expect(TRACK_SUBTREE.bioconductor).toBe("r/bioconductor");
        expect(TRACK_SUBTREE.github).toBe("r/github");
        expect(TRACK_SUBTREE.python).toBe("python");
        expect(TRACK_SUBTREE.node).toBe("node");
        expect(TRACK_SUBTREE.conda).toBe("conda");
    });
});

describe("DOCKER_PLATFORM", () => {
    test("covers every arch with its docker --platform value", () => {
        // Total map: a store's native binaries must never run under a mismatched-arch
        // container, so every published arch has to resolve to a concrete --platform.
        for (const arch of ARCHES) {
            expect(DOCKER_PLATFORM[arch]).toBeDefined();
        }
        expect(DOCKER_PLATFORM["linux-amd64"]).toBe("linux/amd64");
        expect(DOCKER_PLATFORM["linux-arm64"]).toBe("linux/arm64");
    });
});
