import { Command } from "commander";
import { describe, expect, test } from "bun:test";

import { getAgentPolicy, getCommandKind, registerAction, setAgentPolicy, type AgentPolicy, type CommandKind, type RegisterOpts } from "./agent_policy.ts";
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
        registerAction(leaf, "standalone", policy, () => {});
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
        registerAction(leaf, "standalone", { kind: "auto", safeFlags: ["json"] }, async (opts: { json?: boolean }) => {
            seenJson = opts.json;
        });

        await program.parseAsync(["go", "--json"], { from: "user" });

        expect(seenJson).toBe(true);
        expect(getAgentPolicy(leaf)).toEqual({ kind: "auto", safeFlags: ["json"] });
    });
});

describe("agent_policy — a subcommand sees the options its ancestors parsed", () => {
    /** A root + child shaped like the real registry: both declare `--analysis`, only the root declares `--project`. */
    function tree(record: (options: Record<string, unknown>) => void): Command {
        const program = new Command();
        program.exitOverride();
        program.option("--analysis <id|name>", "root scope").option("--project <name>", "root scope");
        registerAction(
            program.command("go").option("--analysis <id|name>", "child scope"),
            "standalone",
            { kind: "approval" },
            (options: Record<string, unknown>) => record(options),
        );
        return program;
    }

    test("a flag the root greedily consumed still reaches the subcommand that declares it", async () => {
        // Commander binds a program option to the command that DECLARED it wherever it sits on the line,
        // so without the hook the child's identically-named option stays empty and the flag reaches no code.
        let seen: Record<string, unknown> = {};
        await tree((o) => (seen = o)).parseAsync(["go", "--analysis", "from-root"], { from: "user" });
        expect(seen["analysis"]).toBe("from-root");
    });

    test("an ancestor option the subcommand does not declare is NOT injected into its handler", async () => {
        // The contract is "the flag this command offers reaches its handler", not "every ancestor flag is
        // visible everywhere" — a command that deliberately declines an option (`geo download` and
        // `--project`) must not be handed one anyway.
        let seen: Record<string, unknown> = {};
        await tree((o) => (seen = o)).parseAsync(["go", "--project", "acme"], { from: "user" });
        expect(seen).not.toHaveProperty("project");
    });

    test("a value the subcommand parsed itself beats the ancestor's", async () => {
        let seen: Record<string, unknown> = {};
        const program = tree((o) => (seen = o));
        // `--analysis` before the subcommand binds on the root; after it, on the child. The child wins.
        await program.parseAsync(["--analysis", "root-one", "go", "--analysis", "child-one"], { from: "user" });
        expect(seen["analysis"]).toBe("child-one");
    });
});

describe("agent_policy — buildProgram instances do not share stamps", () => {
    test("the same-named leaf in two trees is a distinct, independently-stamped Command", () => {
        const a = buildProgram();
        const b = buildProgram();
        const aLs = a.commands.find((c) => c.name() === "ls");
        const bLs = b.commands.find((c) => c.name() === "ls");
        if (aLs === undefined || bLs === undefined) throw new Error("expected an `ls` command in each tree");

        expect(aLs).not.toBe(bLs);
        expect(getAgentPolicy(aLs)).toEqual({ kind: "auto", safeFlags: ["project"] });
        expect(getAgentPolicy(bLs)).toEqual({ kind: "auto", safeFlags: ["project"] });
    });
});

describe("agent_policy — the command kind decides the server check", () => {
    /** One leaf of `kind` with a hidden worker flag, and a log of the server check and the handler, in order. */
    function leaf(kind: CommandKind): { program: Command; calls: string[] } {
        const calls: string[] = [];
        const opts: RegisterOpts = {
            requireServer: async () => {
                calls.push("server-check");
            },
        };
        const program = new Command();
        program.exitOverride();
        const command = program.command("go").option("--run-transfer <kind>", "worker mode");
        registerAction(command, kind, { kind: "approval" }, () => void calls.push("handler"), opts);
        return { program, calls };
    }

    test("an `instance` command finds the server before its handler runs", async () => {
        const { program, calls } = leaf("instance");
        await program.parseAsync(["go"], { from: "user" });
        expect(calls).toEqual(["server-check", "handler"]);
    });

    test("a `machine` or a `standalone` command runs with no server check", async () => {
        for (const kind of ["machine", "standalone"] as const) {
            const { program, calls } = leaf(kind);
            await program.parseAsync(["go"], { from: "user" });
            expect(calls).toEqual(["handler"]);
        }
    });

    test("a machine flag skips the check for that run only", async () => {
        const kind: CommandKind = { kind: "instance", machineFlags: ["runTransfer"] };
        const worker = leaf(kind);
        await worker.program.parseAsync(["go", "--run-transfer", "catalog"], { from: "user" });
        expect(worker.calls).toEqual(["handler"]);

        const client = leaf(kind);
        await client.program.parseAsync(["go"], { from: "user" });
        expect(client.calls).toEqual(["server-check", "handler"]);
    });

    test("the check is not a `preAction` hook: a dry parse that stops in a hook of the root never reaches it", async () => {
        // The argv classifier of `run_inflexa` parses on the side and throws from a root `preAction` hook.
        const calls: string[] = [];
        const program = new Command();
        program.exitOverride();
        registerAction(program, "instance", { kind: "blocked", reason: "test" }, () => void calls.push("handler"), {
            requireServer: async () => void calls.push("server-check"),
        });
        program.hook("preAction", () => {
            throw new Error("classified");
        });
        await expect(program.parseAsync([], { from: "user" })).rejects.toThrow("classified");
        expect(calls).toEqual([]);
    });

    test("the kind is stamped on the Command instance", () => {
        const { program } = leaf("machine");
        const go = program.commands.find((c) => c.name() === "go");
        expect(go === undefined ? undefined : getCommandKind(go)).toBe("machine");
    });
});
