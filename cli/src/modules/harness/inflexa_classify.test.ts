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
    test("a real leaf command resolves to its argv + path + grantKey + policy + setOptions", async () => {
        const argv = ["refs", "download", "reactome-pathways", "--yes"];
        const result = await classifyInflexaArgv(argv);
        expect(result).toEqual({
            kind: "action",
            argv,
            path: ["inflexa", "refs", "download"],
            grantKey: "inflexa refs download",
            policy: { kind: "approval" },
            // `--yes` is explicitly set; the positional dataset id contributes nothing.
            setOptions: ["yes"],
        });
    });

    test("a post-`--` `--help` is an operand, so the argv is an action, NOT introspection", async () => {
        const argv = ["refs", "download", "reactome-pathways", "--", "--help"];
        const result = await classifyInflexaArgv(argv);
        // The injection defense: `--help` after `--` never reaches the help path; it hits the action.
        // The post-`--` `--help` is an operand, never the option, so setOptions stays empty.
        expect(result).toEqual({
            kind: "action",
            argv,
            path: ["inflexa", "refs", "download"],
            grantKey: "inflexa refs download",
            policy: { kind: "approval" },
            setOptions: [],
        });
    });

    test("different arguments of the same command collapse to one grantKey", async () => {
        const reactome = await classifyInflexaArgv(["refs", "download", "reactome-pathways", "--yes"]);
        const wikipathways = await classifyInflexaArgv(["refs", "download", "wikipathways-human", "--yes"]);
        if (reactome.kind !== "action" || wikipathways.kind !== "action") throw new Error("expected actions");
        expect(reactome.grantKey).toBe(wikipathways.grantKey);
        expect(wikipathways.grantKey).toBe("inflexa refs download");
    });

    test("bare `inflexa` (empty argv) is the root action, keyed on the root name alone, carrying the root's blocked policy", async () => {
        const result = await classifyInflexaArgv([]);
        if (result.kind !== "action") throw new Error("expected action");
        expect(result.path).toEqual(["inflexa"]);
        expect(result.grantKey).toBe("inflexa");
        // The root is a blocked TUI launcher; the reason string is pinned at its registration site, not here.
        expect(result.policy?.kind).toBe("blocked");
        expect(result.setOptions).toEqual([]);
    });

    test("a flag-only root invocation is the root action too, not just literally-bare argv", async () => {
        // Pins why the blocked-root message must not say "bare": `--analysis x`
        // carries flags yet still resolves to the root TUI launcher.
        const result = await classifyInflexaArgv(["--analysis", "x"]);
        if (result.kind !== "action") throw new Error("expected action");
        expect(result.grantKey).toBe("inflexa");
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
    test("a single packed command string is split quote-awarely, and the verdict carries the tokenized argv", async () => {
        const result = await classifyInflexaArgv(["refs download reactome-pathways --yes"]);
        // The verdict's argv IS the tokenized form — the single normalization a
        // caller may spawn; re-deriving it from the input would diverge.
        expect(result).toEqual({
            kind: "action",
            argv: ["refs", "download", "reactome-pathways", "--yes"],
            path: ["inflexa", "refs", "download"],
            grantKey: "inflexa refs download",
            policy: { kind: "approval" },
            setOptions: ["yes"],
        });
    });

    // The accepted ambiguity in toEffectiveArgv: one spaced element could be a lone
    // operand rather than a packed command. This pins that the worst case is a
    // malformed verdict (the root takes no positional) — never a wrong spawn.
    test("a single spaced operand tokenizes and lands as malformed, not an action", async () => {
        const result = await classifyInflexaArgv(["My File.txt"]);
        expect(result.kind).toBe("malformed");
    });
});

// The registration-declared policy and the explicitly-set option names ride the action verdict, so the
// tool can run the policy cascade off one parse. `setOptions` uses commander's canonical attributeName,
// keyed on the option-value SOURCE (never an argv string match): a defaulted or unmentioned option is
// not "set", and `--opt=val` / `--no-x` collapse to the same canonical name their long form yields.
describe("classifyInflexaArgv — policy + setOptions", () => {
    test("a blocked-registered command's verdict carries its blocked policy", async () => {
        const result = await classifyInflexaArgv(["config"]);
        if (result.kind !== "action") throw new Error("expected action");
        expect(result.policy?.kind).toBe("blocked");
    });

    test("an approval command's verdict carries the approval policy", async () => {
        const result = await classifyInflexaArgv(["refs", "download", "reactome-pathways", "--yes"]);
        if (result.kind !== "action") throw new Error("expected action");
        expect(result.policy).toEqual({ kind: "approval" });
    });

    test("an auto command's verdict carries the auto policy and its safeFlags", async () => {
        const result = await classifyInflexaArgv(["refs", "list", "--json"]);
        if (result.kind !== "action") throw new Error("expected action");
        expect(result.policy).toEqual({ kind: "auto", safeFlags: ["urls", "json"] });
        expect(result.setOptions).toEqual(["json"]);
    });

    test("`--opt=val` collapses to the same canonical name as `--opt val`", async () => {
        // No command in the registry declares a short form, so the `--opt=val` form stands in for the
        // canonicalization path: both forms resolve through the option's attributeName, never the argv text.
        const attached = await classifyInflexaArgv(["prov", "lineage", "ana", "somefile", "--format=json"]);
        const spaced = await classifyInflexaArgv(["prov", "lineage", "ana", "somefile", "--format", "json"]);
        if (attached.kind !== "action" || spaced.kind !== "action") throw new Error("expected actions");
        expect(attached.setOptions).toEqual(["format"]);
        expect(spaced.setOptions).toEqual(["format"]);
    });

    test("a `--no-x` negation collapses to the option's canonical name", async () => {
        // `--no-auth` sets the `auth` attribute to false (source `cli`), so it reports as the canonical
        // `auth`, not `no-auth`. setup is blocked, but the verdict still carries the parsed option names.
        const result = await classifyInflexaArgv(["setup", "--no-auth"]);
        if (result.kind !== "action") throw new Error("expected action");
        expect(result.setOptions).toContain("auth");
    });

    test("a defaulted option is NOT reported as set", async () => {
        // `prov lineage --format` defaults to "tree"; not mentioning it leaves source "default", which
        // does not count as set — so an out-of-set default never escalates an auto invocation.
        const result = await classifyInflexaArgv(["prov", "lineage", "ana", "somefile"]);
        if (result.kind !== "action") throw new Error("expected action");
        expect(result.setOptions).not.toContain("format");
        expect(result.setOptions).toEqual([]);
    });

    test("post-`--` operands contribute nothing to setOptions", async () => {
        // Everything after `--` is an operand (a variadic id here), never parsed as the `--yes` option.
        const result = await classifyInflexaArgv(["refs", "download", "some-id", "--", "--yes"]);
        if (result.kind !== "action") throw new Error("expected action");
        expect(result.setOptions).toEqual([]);
    });
});
