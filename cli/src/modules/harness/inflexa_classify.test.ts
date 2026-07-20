import { describe, expect, test } from "bun:test";

import { classifyInflexaArgv } from "./inflexa_classify.ts";

// Exercises the classifier against real `buildProgram()` output (no mocked commander): each case pins
// which of the three verdicts an argv resolves to WITHOUT running any action. The `action` cases also pin
// the resolved command path and grantKey, and the `--`-injection case pins that a post-separator `--help`
// is an operand (action), not an introspection request — the defense the classifier exists to provide.

describe("classifyInflexaArgv — introspection", () => {
    test.each([
        ["root --help", ["--help"]],
        ["subgroup --help", ["refs", "--help"]],
        ["leaf --help", ["refs", "download", "--help"]],
        ["--version", ["--version"]],
    ])("%s classifies as introspection", async (_label, argv) => {
        const result = await classifyInflexaArgv(argv);
        expect(result.kind).toBe("introspection");
    });

    test("a bare parent group (no action, prints its own help) is introspection", async () => {
        const result = await classifyInflexaArgv(["refs"]);
        expect(result.kind).toBe("introspection");
    });
});

describe("classifyInflexaArgv — action", () => {
    test("a real leaf command resolves to its path + grantKey", async () => {
        const result = await classifyInflexaArgv(["refs", "download", "reactome-pathways", "--yes"]);
        expect(result).toEqual({ kind: "action", path: ["inflexa", "refs", "download"], grantKey: "inflexa refs download" });
    });

    test("a post-`--` `--help` is an operand, so the argv is an action, NOT introspection", async () => {
        const result = await classifyInflexaArgv(["refs", "download", "reactome-pathways", "--", "--help"]);
        // The injection defense: `--help` after `--` never reaches the help path; it hits the action.
        expect(result).toEqual({ kind: "action", path: ["inflexa", "refs", "download"], grantKey: "inflexa refs download" });
    });

    test("different arguments of the same command collapse to one grantKey", async () => {
        const reactome = await classifyInflexaArgv(["refs", "download", "reactome-pathways", "--yes"]);
        const wikipathways = await classifyInflexaArgv(["refs", "download", "wikipathways-human", "--yes"]);
        expect(reactome).toEqual(wikipathways);
        if (wikipathways.kind !== "action") throw new Error("expected action");
        expect(wikipathways.grantKey).toBe("inflexa refs download");
    });

    test("bare `inflexa` (empty argv) is the root action, keyed on the root name alone", async () => {
        const result = await classifyInflexaArgv([]);
        expect(result).toEqual({ kind: "action", path: ["inflexa"], grantKey: "inflexa" });
    });
});

describe("classifyInflexaArgv — malformed", () => {
    test("an unknown command is malformed with a trimmed message", async () => {
        const result = await classifyInflexaArgv(["bogus-cmd"]);
        expect(result.kind).toBe("malformed");
        if (result.kind !== "malformed") throw new Error("expected malformed");
        expect(result.message.length).toBeGreaterThan(0);
        expect(result.message).toBe(result.message.trim());
    });

    test("an unknown option is malformed", async () => {
        const result = await classifyInflexaArgv(["refs", "--nope"]);
        expect(result.kind).toBe("malformed");
    });

    // `inflexa help <cmd>` is NOT introspection for this program: the root carries a
    // default `.action()`, which disables commander's implicit `help` command (its
    // `_getHelpCommand` gate requires `!actionHandler`). So `help` is an excess
    // operand on the root action → commander.excessArguments. The real `inflexa help
    // refs` binary errors the same way; the classifier faithfully reports malformed.
    test("`help <command>` is malformed, since the root's default action disables the implicit help command", async () => {
        const result = await classifyInflexaArgv(["help", "refs"]);
        expect(result.kind).toBe("malformed");
    });
});

describe("classifyInflexaArgv — defensive tokenization", () => {
    test("a single packed command string is split quote-awarely and classified like split argv", async () => {
        const result = await classifyInflexaArgv(["refs download reactome-pathways --yes"]);
        expect(result).toEqual({ kind: "action", path: ["inflexa", "refs", "download"], grantKey: "inflexa refs download" });
    });

    // The accepted ambiguity in toEffectiveArgv: one spaced element could be a lone
    // operand rather than a packed command. This pins that the worst case is a
    // malformed verdict (the root takes no positional) — never a wrong spawn.
    test("a single spaced operand tokenizes and lands as malformed, not an action", async () => {
        const result = await classifyInflexaArgv(["My File.txt"]);
        expect(result.kind).toBe("malformed");
    });
});
