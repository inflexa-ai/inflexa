import { Command } from "commander";
import { describe, expect, test } from "bun:test";

import { getAgentPolicy, registerAction, setAgentPolicy, type AgentPolicy } from "./agent_policy.ts";
import { buildProgram } from "./index.ts";

describe("agent_policy — stamp round-trips on the Command instance", () => {
    test("a stamped policy is readable from the same Command", () => {
        const cmd = new Command("demo");
        const policy: AgentPolicy = { kind: "auto", safeFlags: ["json"] };
        setAgentPolicy(cmd, policy);
        expect(getAgentPolicy(cmd)).toEqual(policy);
    });

    test("an unstamped Command reads back undefined — nothing bleeds between instances", () => {
        setAgentPolicy(new Command("stamped"), { kind: "approval" });
        // A different, never-stamped Command is undefined: the WeakMap keys on the object, so a stamp on
        // one command is invisible to any other, which is the whole reason a rename cannot orphan a policy.
        expect(getAgentPolicy(new Command("other"))).toBeUndefined();
    });

    test("renaming a registered command cannot orphan its policy — the key is the instance, not the spelling", () => {
        // Spec scenario "A rename cannot orphan a policy": register, then rename. A string-keyed store
        // ("... go") would strand the entry under a dead key, leaving the command silently un-policied; keying
        // on the Command INSTANCE means the same object still reads back the SAME policy after the rename.
        const program = new Command();
        program.exitOverride();
        const policy: AgentPolicy = { kind: "auto", safeFlags: ["json"] };
        const leaf = program.command("go");
        registerAction(leaf, policy, () => {});
        leaf.name("renamed");
        expect(getAgentPolicy(leaf)).toBe(policy);
    });
});

describe("agent_policy — registerAction couples handler and policy", () => {
    test("the handler runs on parse and the policy is stamped in the same call", async () => {
        const program = new Command();
        program.exitOverride();
        let seenJson: boolean | undefined;
        const leaf = program.command("go").option("--json", "emit json");
        registerAction(leaf, { kind: "auto", safeFlags: ["json"] }, async (opts: { json?: boolean }) => {
            seenJson = opts.json;
        });

        await program.parseAsync(["go", "--json"], { from: "user" });

        expect(seenJson).toBe(true);
        expect(getAgentPolicy(leaf)).toEqual({ kind: "auto", safeFlags: ["json"] });
    });
});

describe("agent_policy — buildProgram instances do not share stamps", () => {
    test("the same-named leaf in two trees is a distinct, independently-stamped Command", () => {
        const a = buildProgram();
        const b = buildProgram();
        const aSessions = a.commands.find((c) => c.name() === "sessions");
        const bSessions = b.commands.find((c) => c.name() === "sessions");
        if (aSessions === undefined || bSessions === undefined) throw new Error("expected a `sessions` command in each tree");

        expect(aSessions).not.toBe(bSessions);
        expect(getAgentPolicy(aSessions)).toEqual({ kind: "auto", safeFlags: [] });
        expect(getAgentPolicy(bSessions)).toEqual({ kind: "auto", safeFlags: [] });
    });
});
