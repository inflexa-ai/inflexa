import { AskRejectedError, UnavailableAsk, type AgentSession, type AskApproval, type AskRequest, type ToolContext } from "@inflexa-ai/harness";
import { describe, expect, test } from "bun:test";

import { createRunInflexaTool, resolveInvocation, type RunSubprocess, type SubprocessResult } from "./inflexa_tool.ts";

// A canned subprocess outcome; overridden per-test for the timeout/truncation cases.
const OK_RESULT: SubprocessResult = { exitCode: 0, stdout: "hello", stderr: "", timedOut: false };

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
        const sub = recordingSubprocess({ exitCode: 0, stdout: huge, stderr: "", timedOut: false });
        const tool = makeTool(sub.fn);

        const result = (await tool.execute({ argv: ["--help"] }, makeCtx(recordingAsk({ kind: "once" }).fn)))._unsafeUnwrap();

        expect(result.status).toBe("ran");
        if (result.status !== "ran") throw new Error("expected ran");
        expect(result.stdout.length).toBeLessThan(huge.length);
        expect(result.stdout.endsWith("…[truncated]")).toBe(true);
    });

    test("a timed-out subprocess reports timed_out", async () => {
        const sub = recordingSubprocess({ exitCode: 1, stdout: "", stderr: "", timedOut: true });
        const tool = makeTool(sub.fn);

        const result = (await tool.execute({ argv: ["--help"] }, makeCtx(recordingAsk({ kind: "once" }).fn)))._unsafeUnwrap();

        expect(result.status).toBe("timed_out");
    });

    test("bare inflexa is blocked — never asks, never spawns", async () => {
        const sub = recordingSubprocess();
        const ask = recordingAsk({ kind: "once" });
        const tool = makeTool(sub.fn);

        const result = (await tool.execute({ argv: [] }, makeCtx(ask.fn)))._unsafeUnwrap();

        expect(ask.calls.length).toBe(0);
        expect(sub.calls.length).toBe(0);
        expect(result.status).toBe("blocked");
    });

    test("inflexa config is blocked — never asks, never spawns", async () => {
        const sub = recordingSubprocess();
        const ask = recordingAsk({ kind: "once" });
        const tool = makeTool(sub.fn);

        const result = (await tool.execute({ argv: ["config"] }, makeCtx(ask.fn)))._unsafeUnwrap();

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
});
