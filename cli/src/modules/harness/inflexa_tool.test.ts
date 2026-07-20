import { join } from "node:path";

import { AskRejectedError, UnavailableAsk, type AgentSession, type AskApproval, type AskRequest, type ToolContext } from "@inflexa-ai/harness";
import { describe, expect, test } from "bun:test";

import type { AgentPolicy } from "../../cli/agent_policy.ts";
import { reportAgentPolicies } from "../../test_support/agent_policy_report.ts";
import { createRunInflexaTool, decideAction, resolveInvocation, spawnInflexa, type RunSubprocess, type SubprocessResult } from "./inflexa_tool.ts";

// A canned subprocess outcome; overridden per-test for the timeout/cancel/truncation cases.
const OK_RESULT: SubprocessResult = { exitCode: 0, stdout: "hello", stderr: "", endedBy: "exit" };

/** A `RunSubprocess` that records every `cmd` it is handed and returns a fixed result — no real process. */
function recordingSubprocess(result: SubprocessResult = OK_RESULT): { fn: RunSubprocess; calls: (readonly string[])[] } {
    const calls: (readonly string[])[] = [];
    const fn: RunSubprocess = (cmd, _signal) => {
        calls.push(cmd);
        return Promise.resolve(result);
    };
    return { fn, calls };
}

/** An `ask` seam that records its requests and resolves with a fixed approval. */
function recordingAsk(reply: AskApproval): { fn: (request: AskRequest) => Promise<AskApproval>; calls: AskRequest[] } {
    const calls: AskRequest[] = [];
    const fn = (request: AskRequest): Promise<AskApproval> => {
        calls.push(request);
        return Promise.resolve(reply);
    };
    return { fn, calls };
}

/** A minimal `ToolContext`; the tool reads only `signal` and `ask`, so the rest is inert. */
function makeCtx(ask: (request: AskRequest) => Promise<AskApproval>): ToolContext {
    return {
        // The tool never reads `session`, so a cast avoids constructing the full value object.
        session: {} as unknown as AgentSession,
        signal: new AbortController().signal,
        emit: () => {},
        runStep: (_name, fn) => fn(),
        ask,
    };
}

/** Build the tool with the injected subprocess seam and fixed dev/path deps so no real host state leaks in. */
function makeTool(runSubprocess: RunSubprocess) {
    return createRunInflexaTool({ runSubprocess, isDevelopment: true, execPath: "/bin/bun", scriptPath: "/app/src/index.ts" });
}

describe("resolveInvocation", () => {
    test("dev prepends the bun runtime and the source entry", () => {
        expect(resolveInvocation(["refs", "list"], { isDevelopment: true, execPath: "/bin/bun", scriptPath: "/app/src/index.ts" })).toEqual([
            "/bin/bun",
            "/app/src/index.ts",
            "refs",
            "list",
        ]);
    });

    test("release runs the compiled binary directly (no script path)", () => {
        expect(resolveInvocation(["refs", "list"], { isDevelopment: false, execPath: "/usr/local/bin/inflexa", scriptPath: "/app/src/index.ts" })).toEqual([
            "/usr/local/bin/inflexa",
            "refs",
            "list",
        ]);
    });
});

describe("run_inflexa — execute", () => {
    test("introspection runs immediately without asking", async () => {
        const sub = recordingSubprocess();
        const ask = recordingAsk({ kind: "once" });
        const tool = makeTool(sub.fn);

        const result = (await tool.execute({ argv: ["--help"] }, makeCtx(ask.fn)))._unsafeUnwrap();

        expect(ask.calls.length).toBe(0);
        expect(sub.calls.length).toBe(1);
        expect(sub.calls[0]).toEqual(["/bin/bun", "/app/src/index.ts", "--help"]);
        expect(result.status).toBe("ran");
    });

    test("an action asks with the exact command and subcommand grantKey, then runs on approval", async () => {
        const sub = recordingSubprocess();
        const ask = recordingAsk({ kind: "once" });
        const tool = makeTool(sub.fn);

        const result = (await tool.execute({ argv: ["refs", "download", "x", "--yes"] }, makeCtx(ask.fn)))._unsafeUnwrap();

        expect(ask.calls.length).toBe(1);
        // The displayed command is the EXACT argv; the grant keys on the bare subcommand path.
        expect(ask.calls[0]?.command).toBe("inflexa refs download x --yes");
        expect(ask.calls[0]?.grantKey).toBe("inflexa refs download");
        expect(sub.calls.length).toBe(1);
        expect(result.status).toBe("ran");
    });

    test("a packed single-string argv displays and spawns the SAME tokenized argv", async () => {
        const sub = recordingSubprocess();
        const ask = recordingAsk({ kind: "once" });
        const tool = makeTool(sub.fn);

        const result = (await tool.execute({ argv: ["refs download x --yes"] }, makeCtx(ask.fn)))._unsafeUnwrap();

        // The classifier's verdict argv is the single normalization source: what the
        // user approves is what spawns — never the still-packed input element.
        expect(ask.calls[0]?.command).toBe("inflexa refs download x --yes");
        expect(sub.calls[0]).toEqual(["/bin/bun", "/app/src/index.ts", "refs", "download", "x", "--yes"]);
        expect(result.status).toBe("ran");
    });

    test("an argv element carrying whitespace displays quoted and spawns verbatim", async () => {
        const sub = recordingSubprocess();
        const ask = recordingAsk({ kind: "once" });
        const tool = makeTool(sub.fn);

        const result = (await tool.execute({ argv: ["refs", "download", "my file"] }, makeCtx(ask.fn)))._unsafeUnwrap();

        // Quoted for reading: the word boundaries the user approves are the ones that spawn.
        expect(ask.calls[0]?.command).toBe('inflexa refs download "my file"');
        expect(sub.calls[0]).toEqual(["/bin/bun", "/app/src/index.ts", "refs", "download", "my file"]);
        expect(result.status).toBe("ran");
    });

    test("a rejected approval propagates and never spawns", async () => {
        const sub = recordingSubprocess();
        const reject = (_request: AskRequest): Promise<AskApproval> => Promise.reject(new AskRejectedError("no"));
        const tool = makeTool(sub.fn);

        await expect(tool.execute({ argv: ["refs", "download", "x", "--yes"] }, makeCtx(reject))).rejects.toBeInstanceOf(AskRejectedError);
        expect(sub.calls.length).toBe(0);
    });

    test("malformed argv is invalid — no ask, no spawn", async () => {
        const sub = recordingSubprocess();
        const ask = recordingAsk({ kind: "once" });
        const tool = makeTool(sub.fn);

        const result = (await tool.execute({ argv: ["bogus-cmd"] }, makeCtx(ask.fn)))._unsafeUnwrap();

        expect(ask.calls.length).toBe(0);
        expect(sub.calls.length).toBe(0);
        expect(result.status).toBe("invalid");
        if (result.status !== "invalid") throw new Error("expected invalid");
        expect(result.message.length).toBeGreaterThan(0);
    });

    test("deny-by-default (unwired ask) rejects an action without spawning", async () => {
        const sub = recordingSubprocess();
        const deny = new UnavailableAsk();
        const tool = makeTool(sub.fn);

        await expect(
            tool.execute(
                { argv: ["refs", "download", "x", "--yes"] },
                makeCtx((request) => deny.ask(request)),
            ),
        ).rejects.toBeInstanceOf(AskRejectedError);
        expect(sub.calls.length).toBe(0);
    });

    test("oversized output is truncated with a marker", async () => {
        const huge = "a".repeat(70_000);
        const sub = recordingSubprocess({ exitCode: 0, stdout: huge, stderr: "", endedBy: "exit" });
        const tool = makeTool(sub.fn);

        const result = (await tool.execute({ argv: ["--help"] }, makeCtx(recordingAsk({ kind: "once" }).fn)))._unsafeUnwrap();

        expect(result.status).toBe("ran");
        if (result.status !== "ran") throw new Error("expected ran");
        expect(result.stdout.length).toBeLessThan(huge.length);
        expect(result.stdout.endsWith("…[truncated]")).toBe(true);
    });

    test("a timed-out subprocess reports timed_out with the partial output it produced", async () => {
        const sub = recordingSubprocess({ exitCode: 143, stdout: "downloaded 3 of 7 files", stderr: "", endedBy: "timeout" });
        const tool = makeTool(sub.fn);

        const result = (await tool.execute({ argv: ["--help"] }, makeCtx(recordingAsk({ kind: "once" }).fn)))._unsafeUnwrap();

        expect(result.status).toBe("timed_out");
        if (result.status !== "timed_out") throw new Error("expected timed_out");
        expect(result.stdout).toBe("downloaded 3 of 7 files");
    });

    test("a turn-cancelled subprocess reports cancelled, not a completed run", async () => {
        const sub = recordingSubprocess({ exitCode: 143, stdout: "partial", stderr: "", endedBy: "cancel" });
        const tool = makeTool(sub.fn);

        const result = (await tool.execute({ argv: ["--help"] }, makeCtx(recordingAsk({ kind: "once" }).fn)))._unsafeUnwrap();

        expect(result.status).toBe("cancelled");
    });

    // Refused outright, before any approval prompt. The TUI launchers cannot run
    // captured (`new` would create an analysis before hanging); the infra
    // lifecycle commands would mutate the containers this conversation runs on.
    //
    // This is also the whole proof of spec scenario "A standing grant cannot resurrect a blocked
    // command" — no DB-grant e2e is built because none is needed. An "always" grant is consulted
    // ONLY inside ctx.ask (that seam resolves a matching grant to auto-approve), and decideAction
    // returns `blocked` BEFORE the tool ever reaches ctx.ask. So the `ask.calls.length === 0`
    // assertion below IS the guarantee: the grant-lookup path is provably unreachable for a blocked
    // command, which is exactly why a stale grant keyed on its grantKey can never revive it.
    test.each([
        ["bare inflexa", [] as string[]],
        ["flag-only root inflexa", ["--analysis", "x"]],
        ["inflexa config", ["config"]],
        ["inflexa new", ["new", "myanalysis"]],
        ["inflexa resume", ["resume", "some-analysis"]],
        ["inflexa up", ["up"]],
        ["inflexa down", ["down"]],
        ["inflexa setup", ["setup"]],
    ])("%s is blocked — never asks, never spawns", async (_label, argv) => {
        const sub = recordingSubprocess();
        const ask = recordingAsk({ kind: "once" });
        const tool = makeTool(sub.fn);

        const result = (await tool.execute({ argv }, makeCtx(ask.fn)))._unsafeUnwrap();

        expect(ask.calls.length).toBe(0);
        expect(sub.calls.length).toBe(0);
        expect(result.status).toBe("blocked");
        if (result.status !== "blocked") throw new Error("expected blocked");
        expect(result.message.length).toBeGreaterThan(0);
    });

    test("a blocked command's --help is still introspection and runs", async () => {
        const sub = recordingSubprocess();
        const ask = recordingAsk({ kind: "once" });
        const tool = makeTool(sub.fn);

        const result = (await tool.execute({ argv: ["config", "--help"] }, makeCtx(ask.fn)))._unsafeUnwrap();

        expect(ask.calls.length).toBe(0);
        expect(sub.calls.length).toBe(1);
        expect(result.status).toBe("ran");
    });

    // Auto tier (black-box through the real registry). An `auto` invocation whose explicitly-set options
    // are all safe-listed spawns with NO approval prompt; positionals never enter the decision.
    test("an auto command with a safe flag runs prompt-free", async () => {
        const sub = recordingSubprocess();
        // A spy that fails the test if the tool ever tries to ask — an auto run must not touch the gateway.
        const ask = recordingAsk({ kind: "once" });
        const tool = makeTool(sub.fn);

        const result = (await tool.execute({ argv: ["refs", "list", "--json"] }, makeCtx(ask.fn)))._unsafeUnwrap();

        expect(ask.calls.length).toBe(0);
        expect(sub.calls.length).toBe(1);
        expect(result.status).toBe("ran");
    });

    test("an auto command's positional operand does not escalate", async () => {
        const sub = recordingSubprocess();
        const ask = recordingAsk({ kind: "once" });
        const tool = makeTool(sub.fn);

        // `refs verify` is auto with safeFlags [json]; the dataset id is a positional, which plays no part.
        const result = (await tool.execute({ argv: ["refs", "verify", "reactome-pathways", "--json"] }, makeCtx(ask.fn)))._unsafeUnwrap();

        expect(ask.calls.length).toBe(0);
        expect(sub.calls.length).toBe(1);
        expect(result.status).toBe("ran");
    });

    test("an auto command with only a defaulted option runs prompt-free", async () => {
        const sub = recordingSubprocess();
        const ask = recordingAsk({ kind: "once" });
        const tool = makeTool(sub.fn);

        // `prov lineage --format` defaults to "tree" (unmentioned → source "default" → not "set"), so even
        // though it is safe-listed anyway, the run stays prompt-free with only positionals supplied.
        const result = (await tool.execute({ argv: ["prov", "lineage", "ana", "somefile"] }, makeCtx(ask.fn)))._unsafeUnwrap();

        expect(ask.calls.length).toBe(0);
        expect(sub.calls.length).toBe(1);
        expect(result.status).toBe("ran");
    });

    test("an auto command carrying an inherited flag outside safeFlags escalates to the ask path", async () => {
        const sub = recordingSubprocess();
        const ask = recordingAsk({ kind: "once" });
        const tool = makeTool(sub.fn);

        // `ls` is auto with safeFlags ["project"]; `--analysis` is declared only on the root, never on `ls`,
        // yet the classifier's chain walk counts it as explicitly set. Outside safeFlags, so the auto tier
        // escalates through ctx.ask rather than free-running — proving the shadowed/inherited detection feeds
        // the decision. (There is no free spawn: the only spawn here is the tail of the APPROVED ask.)
        const result = (await tool.execute({ argv: ["ls", "--analysis", "a"] }, makeCtx(ask.fn)))._unsafeUnwrap();

        expect(ask.calls.length).toBe(1);
        expect(ask.calls[0]?.grantKey).toBe("inflexa ls");
        expect(result.status).toBe("ran");
    });
});

// The escalation (out-of-set flag) and fail-closed (no policy) branches are unreachable through the real
// registry — every command is stamped, and no auto command currently declares an out-of-set option — so
// they are exercised at `decideAction`, the pure seam `execute` runs. These pin the two invariants the
// black-box tests above cannot: an unknown flag escalates auto→ask (never runs free), and a policy-less
// action fails closed to blocked (never silently approvable).
// The description is what the agent knows about this tool, and it is DERIVED from the
// registry so it cannot drift out of sync with what the tool will actually let it run.
// The invariant worth holding is coverage: a command the agent may invoke, or is barred
// from invoking, has to appear — a registered command missing from its own tool's
// description is a capability the agent will never discover, or one it wastes a turn on.
describe("run_inflexa — the described surface tracks the registry", () => {
    test("every policy-stamped command appears, grouped by what it costs the user", () => {
        const { description } = createRunInflexaTool();
        for (const row of reportAgentPolicies()) {
            // `reportAgentPolicies` walks from the root, whose own grantKey is the bare
            // program name and carries no policy of its own to describe.
            if (row.grantKey === "inflexa") continue;
            const path = row.grantKey.replace(/^inflexa /, "");
            expect(description).toContain(`\`${path}\``);
        }
    });

    test("a read-only command and an approval-gated one land in different groups", () => {
        const { description } = createRunInflexaTool();
        const free = description.indexOf("Read-only, and normally run without interrupting the user");
        const gated = description.indexOf("Always stop for the user's approval first");
        const blocked = description.indexOf("Not available through this tool at all");
        expect(free).toBeGreaterThan(-1);
        expect(gated).toBeGreaterThan(free);
        expect(blocked).toBeGreaterThan(gated);
        // `refs list` only reads the store; `refs download` fetches and writes. The agent
        // reporting reference data as unobtainable is exactly the failure this prevents.
        expect(description.slice(free, gated)).toContain("`refs list`");
        expect(description.slice(gated, blocked)).toContain("`refs download`");
    });
});

describe("decideAction — policy cascade", () => {
    test("no policy fails closed to blocked with a developer-facing message", () => {
        const decision = decideAction(undefined, "inflexa mystery", []);
        expect(decision.kind).toBe("blocked");
        if (decision.kind !== "blocked") throw new Error("expected blocked");
        expect(decision.message).toContain("not classified for agent use");
    });

    test("a blocked policy returns its declared reason, before any grant/ask", () => {
        const policy: AgentPolicy = { kind: "blocked", reason: "nope, this one is off-limits" };
        expect(decideAction(policy, "inflexa down", [])).toEqual({ kind: "blocked", message: "nope, this one is off-limits" });
    });

    test("an auto invocation with every set option safe-listed spawns", () => {
        const policy: AgentPolicy = { kind: "auto", safeFlags: ["json", "urls"] };
        expect(decideAction(policy, "inflexa refs list", ["json"])).toEqual({ kind: "spawn" });
        expect(decideAction(policy, "inflexa refs list", [])).toEqual({ kind: "spawn" });
    });

    test("an auto invocation with an out-of-set option escalates to ask, never blocked", () => {
        const policy: AgentPolicy = { kind: "auto", safeFlags: ["json"] };
        expect(decideAction(policy, "inflexa refs list", ["json", "danger"])).toEqual({ kind: "ask" });
        expect(decideAction(policy, "inflexa refs list", ["danger"])).toEqual({ kind: "ask" });
    });

    test("an approval policy always asks", () => {
        expect(decideAction({ kind: "approval" }, "inflexa refs download", ["yes"])).toEqual({ kind: "ask" });
    });
});

// Real processes (bun -e children), because the bounds under test — pipe
// backpressure, EOF held open by a grandchild, a trapped SIGTERM — only exist
// against a live OS process. Graces are shrunk so the suite stays fast.
describe("spawnInflexa — process bounds", () => {
    const bun = process.execPath;
    const live = (): AbortSignal => new AbortController().signal;

    test("runaway output is capped at the source, not buffered whole", async () => {
        const r = await spawnInflexa([bun, "-e", 'process.stdout.write("a".repeat(200000));'], live(), { timeoutMs: 10_000, flushGraceMs: 200 });

        expect(r.endedBy).toBe("exit");
        expect(r.exitCode).toBe(0);
        expect(r.stdout.endsWith("…[truncated]")).toBe(true);
        expect(r.stdout.length).toBeLessThan(70_000);
    });

    test("the output cap is one budget across stdout AND stderr, not per stream", async () => {
        // 40k + 40k exceeds the 60k run budget; per-stream caps would keep all 80k.
        const script = 'process.stdout.write("a".repeat(40000)); process.stderr.write("b".repeat(40000));';
        const r = await spawnInflexa([bun, "-e", script], live(), { timeoutMs: 10_000, flushGraceMs: 300 });

        expect(r.endedBy).toBe("exit");
        const marker = "…[truncated]";
        const kept = r.stdout.length + r.stderr.length - (r.stdout.endsWith(marker) ? marker.length : 0) - (r.stderr.endsWith(marker) ? marker.length : 0);
        expect(kept).toBeLessThanOrEqual(60_000);
        expect(r.stdout.endsWith(marker) || r.stderr.endsWith(marker)).toBe(true);
        // Shared first-come-first-served, not winner-takes-all: 40k per stream never
        // exhausts the pool alone, so both streams keep real output.
        expect(r.stdout.length).toBeGreaterThan(0);
        expect(r.stderr.length).toBeGreaterThan(0);
    });

    test("a grandchild holding the pipes open does not stall past the child's exit", async () => {
        // The child hands its pipes to a 6s `sleep` and exits at once; EOF never
        // arrives until that grandchild dies. The flush grace must return us long
        // before then, with the child's own output intact.
        const script =
            'Bun.spawn({ cmd: ["sleep", "6"], stdout: "inherit", stderr: "inherit" }); process.stdout.write("parent-done"); setTimeout(() => process.exit(0), 100);';
        const started = performance.now();
        const r = await spawnInflexa([bun, "-e", script], live(), { timeoutMs: 10_000, flushGraceMs: 300 });
        const elapsed = performance.now() - started;

        expect(r.endedBy).toBe("exit");
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("parent-done");
        expect(elapsed).toBeLessThan(3_000);
    });

    test("a SIGTERM-trapping child is SIGKILLed, so the deadline is a real bound", async () => {
        const script = 'process.on("SIGTERM", () => {}); process.stdout.write("trapped"); setTimeout(() => {}, 30000);';
        const started = performance.now();
        const r = await spawnInflexa([bun, "-e", script], live(), { timeoutMs: 300, flushGraceMs: 200, killGraceMs: 400 });
        const elapsed = performance.now() - started;

        expect(r.endedBy).toBe("timeout");
        // The partial output written before the deadline still comes back.
        expect(r.stdout).toBe("trapped");
        expect(elapsed).toBeLessThan(4_000);
    });

    test("the caller's abort reports cancel, not timeout and not a plain exit", async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);
        const r = await spawnInflexa([bun, "-e", "setTimeout(() => {}, 30000);"], controller.signal, {
            timeoutMs: 10_000,
            flushGraceMs: 200,
            killGraceMs: 400,
        });

        expect(r.endedBy).toBe("cancel");
    });

    test("a confirm()-gated path declines on the spawn's ignored stdin — EOF is never consent", async () => {
        // The always-grant trade-off (an `always` on `inflexa X` also covers a later
        // `inflexa X --destructive`) leans on a cross-module invariant: every
        // destructive text-command path gates on lib/cli.ts's confirm(), whose
        // non-TTY branch reads stdin to EOF and treats silence as a decline. The
        // tool spawns with `stdin: "ignore"`, so that read EOFs at once. Pinned
        // against a real child running the real confirm(): a future confirm()
        // change that defaults silence to consent must fail here, not ship a
        // data-loss path behind a standing grant.
        const confirmModule = join(import.meta.dir, "../../lib/cli.ts");
        // Bun.spawn's default child env is a STARTUP SNAPSHOT, so the child
        // inherits `bun test`'s NODE_ENV but NOT the preload's runtime-stamped
        // sandbox marker — and lib/cli.ts transitively imports lib/env.ts, whose
        // data-loss guard refuses exactly that combination. Re-stamp the parent
        // test's own sandbox inside the child, before the import, so the child
        // resolves paths in the same sandbox this suite runs in. `Bun.env` (not
        // `process.env`) is the live env and the sanctioned way to read it here
        // (the runCli helper forwards the sandbox the same way).
        const sandboxEnv = {
            XDG_DATA_HOME: Bun.env.XDG_DATA_HOME,
            XDG_CONFIG_HOME: Bun.env.XDG_CONFIG_HOME,
            INFLEXA_TEST_SANDBOX: Bun.env.INFLEXA_TEST_SANDBOX,
        };
        const script =
            `Object.assign(process.env, ${JSON.stringify(sandboxEnv)}); ` +
            `const { confirm } = await import(${JSON.stringify(confirmModule)}); ` +
            `process.stdout.write((await confirm("Proceed?")) ? "PROCEEDED" : "DECLINED");`;
        const r = await spawnInflexa([bun, "-e", script], live(), { timeoutMs: 10_000, flushGraceMs: 300 });

        expect(r.endedBy).toBe("exit");
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("DECLINED");
    });
});
